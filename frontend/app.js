(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const MAX_BYTES = 10 * 1024 * 1024;
  const ALLOWED = ["image/jpeg", "image/png", "image/webp"];
  const REQUEST_TIMEOUT_MS = 120000; // generous: the very first request can wait for the model to load
  const REQUIRED_FIELDS = ["item", "category", "condition", "confidence", "pathway", "reason", "next_action", "alternative"];

  // Backend pathway label -> css key (v-repair, v-reuse, ...)
  const PATH_KEY = { "Repair": "repair", "Reuse / Donate": "reuse", "Recycle": "recycle", "Discard": "discard" };

  const COND_NOTE = {
    good: "No visible damage.",
    worn: "Visible wear, but intact.",
    damaged: "Visible damage.",
    unknown: "Couldn't be judged from this photo.",
  };

  // Example photos: put real images in frontend/samples/. A chip only shows if its file exists.
  const EXAMPLES = [
    { name: "Wobbly chair", src: "samples/chair.jpg" },
    { name: "Denim jacket", src: "samples/jacket.jpg" },
    { name: "Old laptop", src: "samples/laptop.jpg" },
    { name: "Ceramic mug", src: "samples/mug.jpg" },
  ];

  // Visual guide only: the backend does all of this in ONE request.
  // The last stage stays active until the real response arrives.
  const STAGES = [
    { label: "Inspecting image", ms: 600, note: () => (current && current.dims) || "Image OK" },
    { label: "Identifying item", ms: 800 },
    { label: "Assessing condition", ms: 900 },
    { label: "Finding best route", ms: 500 },
  ];

  const SUGGEST_GENERAL = ["How do I donate electronics safely?", "Where do batteries go?", "When is repair worth it?"];
  const SUGGEST_ITEM = ["Why this route?", "Is there an alternative?", "How do I prepare it?"];
  const STATE_LABEL = { empty: "Ready", ready: "Loaded", analyzing: "Scanning", done: "Complete" };
  const STORE_KEY = "reroute.tally.v1";

  // ---------- Elements ----------
  const el = {
    status: $("#status"), statusText: $("#status-text"),
    scanner: $("#scanner"), scannerState: $("#scanner-state"),
    dropzone: $("#dropzone"), input: $("#file-input"),
    empty: $("#dz-empty"), previewBox: $("#dz-preview"), img: $("#preview"), stamp: $("#stamp"),
    fileRow: $("#file-row"), fileName: $("#file-name"), fileMeta: $("#file-meta"),
    details: $("#details"), error: $("#error"),
    examplesBox: $("#examples"), examples: $("#example-list"),
    panelActions: $("#panel-actions"), panelAnalysis: $("#panel-analysis"), panelDone: $("#panel-done"),
    analyze: $("#analyze-btn"), clear: $("#clear-btn"), cancel: $("#cancel-btn"), edit: $("#edit-btn"),
    stages: $("#stages"), progressFill: $("#progress-fill"),
    result: $("#result"), resRule: $("#res-rule"),
    jThumb: $("#j-thumb"), jNode3: $("#j-node-3"),
    jCap1: $("#j-cap-1"), jCap2: $("#j-cap-2"), jCap3: $("#j-cap-3"), jCap4: $("#j-cap-4"),
    resItem: $("#res-item"), resItemNote: $("#res-item-note"),
    resCondition: $("#res-condition"), resCondNote: $("#res-condition-note"),
    resConfText: $("#res-conf-text"), resConf: $("#res-conf"),
    resVerdict: $("#res-verdict"),
    resReason: $("#res-reason"), resNext: $("#res-next"), resAlt: $("#res-alt"),
    statItems: $("#stat-items"), statKeep: $("#stat-keep"), statRecycle: $("#stat-recycle"), statDiscard: $("#stat-discard"),
    chatLog: $("#chat-log"), chatForm: $("#chat-form"), chatInput: $("#chat-input"), chatMode: $("#chat-mode"),
    chatContext: $("#chat-context"), chatSuggest: $("#chat-suggest"),
  };
  const chatSend = el.chatForm.querySelector("button");

  let current = null;   // { name, file, dims? }
  let objectUrl = null;
  let busy = false;
  let runId = 0;        // lets Cancel/Clear invalidate a running analysis
  let abortCtl = null;

  // ---------- Backend badge + model loading ----------
  async function checkBackend() {
    try {
      const res = await fetch("/api/health");
      if (!res.ok) throw new Error();
      const h = await res.json();
      el.chatMode.textContent = h.chat_mode === "ai" ? "AI + guidelines" : "Guidelines only";
      if (!h.vision_ready) {
        el.statusText.textContent = "Loading vision model…";
        el.status.className = "status";
        setTimeout(checkBackend, 3000);
        return;
      }
      el.statusText.textContent = "API online";
      el.status.className = "status ok";
    } catch {
      el.statusText.textContent = "API offline";
      el.status.className = "status down";
    }
  }

  // ---------- View states: empty | ready | analyzing | done ----------
  function setView(view) {
    el.scanner.dataset.state = view;
    el.scannerState.textContent = STATE_LABEL[view];
    el.panelActions.hidden = !(view === "empty" || view === "ready");
    el.panelAnalysis.hidden = view !== "analyzing";
    el.panelDone.hidden = view !== "done";
    el.details.hidden = view !== "ready";
    el.result.hidden = view !== "done";
    el.stamp.hidden = view !== "done";
    el.clear.hidden = view !== "ready";
    el.analyze.disabled = view !== "ready";
    el.examples.querySelectorAll("button").forEach((b) => (b.disabled = view === "analyzing"));
  }

  function showError(msg) { el.error.textContent = msg; el.error.hidden = false; }
  function hideError() { el.error.hidden = true; }

  function formatSize(bytes) {
    return bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
  }

  function stopRun() {
    runId++;
    busy = false;
    if (abortCtl) { abortCtl.abort(); abortCtl = null; }
  }

  const radio = (name) => (document.querySelector(`input[name="${name}"]:checked`) || {}).value || "";
  function resetDetails() {
    document.querySelectorAll('input[name="condition"], input[name="works"]').forEach((r) => { r.checked = r.value === ""; });
  }

  // ---------- Loading an image ----------
  function showPreview(src, fileName, sizeText) {
    stopRun();
    el.fileName.textContent = fileName;
    el.fileMeta.textContent = sizeText;
    el.fileRow.hidden = false;
    el.empty.hidden = true;
    el.previewBox.hidden = false;
    hideError();
    resetDetails();
    el.img.onload = () => {
      if (!current) return;
      current.dims = `${el.img.naturalWidth}×${el.img.naturalHeight}px`;
      el.fileMeta.textContent = `${sizeText} · ${current.dims}`;
    };
    el.img.src = src;
    setView("ready");
  }

  function handleFile(file) {
    if (busy) return;
    hideError();
    if (!file) return;
    if (!ALLOWED.includes(file.type)) return showError("Please choose a JPG, PNG, or WebP image.");
    if (file.size > MAX_BYTES) return showError("That image is over 10 MB. Try a smaller one.");
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    current = { name: file.name.replace(/\.[^.]+$/, ""), file };
    showPreview(objectUrl, file.name, formatSize(file.size));
  }

  async function handleExample(ex) {
    if (busy) return;
    hideError();
    try {
      const res = await fetch(ex.src);
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      handleFile(new File([blob], ex.src.split("/").pop(), { type: blob.type }));
    } catch {
      showError("Couldn't load that example photo.");
    }
  }

  function clearAll() {
    stopRun();
    current = null;
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    el.input.value = "";
    el.img.onload = null;
    el.img.removeAttribute("src");
    el.previewBox.hidden = true;
    el.empty.hidden = false;
    el.fileRow.hidden = true;
    hideError();
    resetDetails();
    setChatItem(null);
    setView("empty");
  }

  // ---------- Stage list ----------
  function buildStages() {
    el.stages.replaceChildren(
      ...STAGES.map((s) => {
        const li = document.createElement("li");
        li.innerHTML = '<span class="st-icon"></span><span class="st-text"></span><span class="st-note"></span>';
        li.querySelector(".st-text").textContent = s.label;
        return li;
      })
    );
  }

  function setProgress(fraction, ms) {
    el.progressFill.style.transitionDuration = ms + "ms";
    el.progressFill.style.width = fraction * 100 + "%";
  }

  // ---------- Real API call: /api/analyze ----------
  function errorMessage(body, status) {
    const d = body && body.detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d) && d.length) return "The request was rejected. Please check your photo and try again.";
    return `Something went wrong (error ${status}).`;
  }

  async function shrink(file) {
    if (file.size <= 3.5 * 1024 * 1024) return file;
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
      return blob ? new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
    } catch { return file; }
  }

  async function callAnalyze(file, signal, condition, works) {
    file = await shrink(file);
    const form = new FormData();
    form.append("file", file);
    if (condition) form.append("condition", condition);
    if (works) form.append("works", works);
    let res;
    try {
      res = await fetch("/api/analyze", { method: "POST", body: form, signal });
    } catch (err) {
      throw new Error(
        err.name === "AbortError"
          ? "The analysis took too long. Please try again."
          : "Can't reach the server. Make sure the backend is running."
      );
    }
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON error page */ }
    if (!res.ok) throw new Error(errorMessage(body, res.status));
    if (!body || REQUIRED_FIELDS.some((k) => !(k in body))) throw new Error("The server sent an unexpected response.");
    return body;
  }

  async function analyze() {
    if (!current || busy) return;
    busy = true;
    const run = ++runId;
    hideError();
    buildStages();
    setProgress(0, 0);
    const condition = radio("condition"), works = radio("works");
    setView("analyzing");
    el.scanner.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });

    const controller = new AbortController();
    abortCtl = controller;
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let outcome = null;
    const request = callAnalyze(current.file, controller.signal, condition, works)
      .then((data) => (outcome = { ok: true, data }), (err) => (outcome = { ok: false, err }))
      .finally(() => clearTimeout(timer));

    const items = [...el.stages.children];
    for (let i = 0; i < STAGES.length; i++) {
      const last = i === STAGES.length - 1;
      const ms = reduceMotion ? 200 : STAGES[i].ms;
      items[i].classList.add("active");
      requestAnimationFrame(() =>
        requestAnimationFrame(() => setProgress(last ? 0.9 : (i + 1) / STAGES.length, last ? 2500 : ms))
      );
      await (last ? Promise.all([sleep(ms), request]) : sleep(ms)); // last stage waits for the real response
      if (run !== runId) return;                                    // cancelled or replaced
      if (outcome && !outcome.ok) break;                            // failed early: stop animating
      items[i].classList.replace("active", "done");
      const note = STAGES[i].note && STAGES[i].note();
      if (note) items[i].querySelector(".st-note").textContent = note;
    }

    await request;
    if (run !== runId) return;
    if (!outcome.ok) {
      busy = false;
      abortCtl = null;
      setView("ready");
      showError(outcome.err.message);
      return;
    }

    setProgress(1, 200);
    await sleep(reduceMotion ? 0 : 300);
    if (run !== runId) return;

    busy = false;
    abortCtl = null;
    const data = outcome.data;
    const key = PATH_KEY[data.pathway] || "discard";
    renderResult(data, key);
    setView("done");
    recordScan(data);
    setChatItem(data);
    el.result.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });
  }

  function cancelAnalysis() {
    if (!busy) return;
    stopRun();
    setView("ready");
  }

  // ---------- Result rendering (all text via textContent) ----------
  const capitalizeFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

  function firstSentence(text) {
    const m = text.match(/^.*?[.!?](\s|$)/);
    const s = (m ? m[0] : text).trim();
    return s.length > 110 ? s.slice(0, 107).trimEnd() + "…" : s;
  }

  function renderResult(d, key) {
    const pct = Math.round(d.confidence * 100);
    const band = d.confidence >= 0.6 ? "High" : d.confidence >= 0.35 ? "Medium" : "Low";
    const cond = COND_NOTE[d.condition] ? d.condition : "unknown";
    const alsoSeen = (d.candidates || []).slice(1).map((c) => `${c.item} (${Math.round(c.confidence * 100)}%)`);

    // Journey
    el.jThumb.src = el.img.src;
    el.jCap1.textContent = current ? current.name : "Your photo";
    el.jCap2.textContent = `${capitalizeFirst(d.item)} · ${pct}%`;
    el.jCap3.textContent = d.pathway;
    el.jCap4.textContent = firstSentence(d.next_action);
    el.jNode3.className = `j-node v-${key}`;
    el.resRule.textContent = `Rule: ${d.rule_id || "n/a"}`;

    // Details
    el.resItem.textContent = capitalizeFirst(d.item);
    el.resItemNote.textContent = alsoSeen.length ? `Also looks like: ${alsoSeen.join(", ")}` : "";
    el.resCondition.textContent = d.condition === "unknown" ? "not specified" : d.condition;
    el.resCondition.className = `tag cond cond-${cond}`;
    el.resCondNote.textContent = d.condition_source === "you"
      ? `${COND_NOTE[cond]} (Provided by you.)`
      : d.condition === "unknown"
        ? "The photo didn't show the condition clearly. Use “Change details” to tell us."
        : "Estimated by the AI from the photo. Use “Change details” if it's wrong.";
    el.resConfText.textContent = `${pct}% · ${band}`;
    el.resConf.style.width = pct + "%";
    el.resVerdict.textContent = d.pathway;
    el.resVerdict.className = `verdict verdict-xl v-${key}`;
    el.resReason.textContent = d.reason;
    el.resNext.textContent = d.next_action;
    el.resAlt.textContent = d.alternative;

    // Stamp on the photo
    el.stamp.textContent = d.pathway;
    el.stamp.className = `stamp v-${key}`;
  }

  // ---------- Impact dashboard (history saved in this browser; optional sample data from mock-data.js) ----------
  const HIST_KEY = "reroute.history.v1", DAY = 864e5;
  const PATHS = [["Repair", "repair"], ["Reuse / Donate", "reuse"], ["Recycle", "recycle"], ["Discard", "discard"]];
  const CATS = ["electronics", "clothing", "furniture", "household", "other"];
  const sod = new Date(); sod.setHours(0, 0, 0, 0);
  const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const dayIndex = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return Math.round((sod - d) / DAY); };
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

  function loadHistory() {
    try { const a = JSON.parse(localStorage.getItem(HIST_KEY)); return Array.isArray(a) ? a : []; } catch { return []; }
  }
  let history = loadHistory();
  const sample = (window.MOCK_DASHBOARD || []).map(([d, item, category, pathway, confidence]) =>
    ({ t: sod.getTime() - d * DAY + 12 * 36e5, item, category, pathway, confidence }));
  $("#sample-badge").hidden = !sample.length;
  const shown = { items: 0, keep: 0, recycle: 0, discard: 0 };

  function animateNumber(node, from, to) {
    if (reduceMotion || from === to) { node.textContent = to; return; }
    const start = performance.now(), dur = 600;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / dur);
      node.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - t, 3)));
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function legend(node, rows) {
    node.replaceChildren(...rows.map(([key, label, text]) => {
      const li = mk("li"); const dot = mk("i", "c-" + key);
      li.append(dot, mk("span", "", text ? `${label} · ${text}` : label)); return li;
    }));
  }

  function renderDash() {
    const all = [...sample, ...history].sort((a, b) => b.t - a.t);
    const n = all.length, cnt = { repair: 0, reuse: 0, recycle: 0, discard: 0 }, cat = {};
    let conf = 0;
    all.forEach((e) => { cnt[PATH_KEY[e.pathway] || "discard"]++; cat[e.category] = (cat[e.category] || 0) + 1; conf += e.confidence || 0; });
    const keep = cnt.repair + cnt.reuse;
    const week = Array.from({ length: 7 }, () => ({ repair: 0, reuse: 0, recycle: 0, discard: 0 }));
    all.forEach((e) => { const i = dayIndex(e.t); if (i >= 0 && i <= 6) week[6 - i][PATH_KEY[e.pathway] || "discard"]++; });
    const wk = week.reduce((a, d) => a + d.repair + d.reuse + d.recycle + d.discard, 0);

    const now = { items: n, keep, recycle: cnt.recycle, discard: cnt.discard };
    [["items", "#stat-items"], ["keep", "#stat-keep"], ["recycle", "#stat-recycle"], ["discard", "#stat-discard"]]
      .forEach(([k, id]) => { animateNumber($(id), shown[k], now[k]); shown[k] = now[k]; });
    $("#sub-items").textContent = `${wk} in the last 7 days`;
    $("#sub-keep").textContent = `${pct(keep, n)}% repaired or reused`;
    $("#sub-recycle").textContent = `${pct(cnt.recycle, n)}% of items`;
    $("#sub-discard").textContent = `${pct(cnt.discard, n)}% last resort`;
    $("#avg-conf").textContent = n ? `Avg confidence ${Math.round((conf / n) * 100)}%` : "";

    // 7-day stacked bars
    const max = Math.max(1, ...week.map((d) => d.repair + d.reuse + d.recycle + d.discard));
    $("#chart-week").replaceChildren(...week.map((d, i) => {
      const total = d.repair + d.reuse + d.recycle + d.discard;
      const col = mk("div", "wcol"), stack = mk("div", "wstack");
      PATHS.forEach(([, k]) => { if (d[k]) { const seg = mk("div", "wseg c-" + k); seg.style.height = `${(d[k] / max) * 100}%`; stack.append(seg); } });
      const day = new Date(sod.getTime() - (6 - i) * DAY).toLocaleDateString(undefined, { weekday: "short" });
      col.append(mk("span", "wval", total || ""), stack, mk("span", "wday", day)); return col;
    }));
    legend($("#week-legend"), PATHS.map(([l, k]) => [k, l]));

    // donut
    const C = 2 * Math.PI * 36; let off = 0;
    $("#donut").innerHTML = '<circle class="s-track" cx="50" cy="50" r="36"/>' + PATHS.map(([, k]) => {
      const len = n ? (cnt[k] / n) * C : 0, s = `<circle class="s-${k}" cx="50" cy="50" r="36" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 50 50)"/>`;
      off += len; return len ? s : "";
    }).join("");
    $("#donut-pct").textContent = `${pct(keep, n)}%`;
    legend($("#mix-legend"), PATHS.map(([l, k]) => [k, l, `${cnt[k]} (${pct(cnt[k], n)}%)`]));

    // categories
    const rows = CATS.filter((c) => cat[c]).sort((a, b) => cat[b] - cat[a]), top = Math.max(1, ...Object.values(cat));
    $("#chart-cat").replaceChildren(...(rows.length ? rows.map((c) => {
      const r = mk("div", "hrow"), tr = mk("div", "htrack"), f = mk("div", "hfill");
      f.style.width = `${(cat[c] / top) * 100}%`; tr.append(f);
      r.append(mk("span", "hname", c), tr, mk("span", "hnum", cat[c])); return r;
    }) : [mk("p", "muted-small", "No scans yet.")]));

    // recent
    $("#recent-list").replaceChildren(...(n ? all.slice(0, 6).map((e) => {
      const li = mk("li"), key = PATH_KEY[e.pathway] || "discard", i = dayIndex(e.t);
      li.append(mk("span", "r-item", capitalizeFirst(e.item)), mk("span", "r-cat", e.category), mk("span", `tag v-${key}`, e.pathway),
        mk("span", "r-time", i <= 0 ? "Today" : i === 1 ? "Yesterday" : `${i}d ago`)); return li;
    }) : [mk("li", "muted-small", "No scans yet.")]));
  }

  function recordScan(d) {
    history.push({ t: Date.now(), item: d.item, category: d.category, pathway: d.pathway, confidence: d.confidence });
    history = history.slice(-200);
    try { localStorage.setItem(HIST_KEY, JSON.stringify(history)); } catch { /* ignore */ }
    renderDash();
  }
  $("#reset-btn").addEventListener("click", () => {
    history = [];
    try { localStorage.removeItem(HIST_KEY); } catch { /* ignore */ }
    renderDash();
  });
  renderDash();

  // ---------- Chat (RAG): /api/chat ----------
  let chatItem = null;        // the last analysis result, sent as context
  let chatHistory = [];       // real turns only: { role: "user"|"assistant", content }
  let chatBusy = false;

  function setChatItem(data) {
    chatItem = data;
    el.chatContext.textContent = data
      ? `Item in focus: ${capitalizeFirst(data.item)} → ${data.pathway}`
      : "No item scanned yet";
    renderSuggestions();
  }

  function renderSuggestions() {
    el.chatSuggest.replaceChildren(
      ...(chatItem ? SUGGEST_ITEM : SUGGEST_GENERAL).map((q) => {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.className = "chip";
        b.textContent = q;
        b.disabled = chatBusy;
        b.addEventListener("click", () => sendChat(q));
        li.appendChild(b);
        return li;
      })
    );
  }

  function addMessage(role, text, extraClass, sources) {
    const div = document.createElement("div");
    div.className = `msg msg-${role}${extraClass ? " " + extraClass : ""}`;
    div.textContent = text;
    if (sources && sources.length) {
      const s = document.createElement("div");
      s.className = "msg-sources";
      s.textContent = "Sources: " + sources.map((x) => x.title).join(" · ");
      div.appendChild(s);
    }
    el.chatLog.appendChild(div);
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
    return div;
  }

  function setChatBusy(on) {
    chatBusy = on;
    el.chatInput.disabled = on;
    chatSend.disabled = on;
    el.chatSuggest.querySelectorAll("button").forEach((b) => (b.disabled = on));
  }

  async function sendChat(text) {
    if (chatBusy) return;
    addMessage("user", text);
    const bubble = addMessage("bot", "•••", "msg-typing");
    setChatBusy(true);
    let answer = "", sources = [];
    try {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text, item: chatItem, history: chatHistory.slice(-8) }),
      });
      if (!res.ok) {
        let d = null;
        try { d = (await res.json()).detail; } catch { /* ignore */ }
        bubble.className = "msg msg-bot msg-error";
        bubble.textContent = typeof d === "string" ? d : "Sorry, I couldn't answer that. Please check your question and try again.";
        return;
      }
      const reader = res.body.getReader(), decoder = new TextDecoder();
      let buf = "";
      const handle = (ev) => {
        if (ev.type === "meta") sources = ev.sources || [];
        else if (ev.type === "token") answer += ev.text;
        else if (ev.type === "fallback") answer = ev.text;
        else return;
        bubble.classList.remove("msg-typing");
        bubble.textContent = answer;
        el.chatLog.scrollTop = el.chatLog.scrollHeight;
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop();
        for (const part of parts) {
          if (!part.startsWith("data:")) continue;
          try { handle(JSON.parse(part.slice(5))); } catch { /* ignore a broken chunk */ }
        }
      }
      if (sources.length) {
        const s = document.createElement("div");
        s.className = "msg-sources";
        s.textContent = "Sources: " + sources.map((x) => x.title).join(" · ");
        bubble.appendChild(s);
      }
      if (answer) {
        chatHistory.push({ role: "user", content: text }, { role: "assistant", content: answer });
        chatHistory = chatHistory.slice(-20);
      } else {
        bubble.className = "msg msg-bot msg-error";
        bubble.textContent = "No answer came back. Please try again.";
      }
    } catch {
      bubble.className = "msg msg-bot msg-error";
      bubble.textContent = "Can't reach the server. Make sure the backend is running.";
    } finally {
      setChatBusy(false);
      el.chatInput.focus();
    }
  }

  el.chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = el.chatInput.value.trim();
    if (!text) return;
    el.chatInput.value = "";
    sendChat(text);
  });

  addMessage("bot", "Ask about repairing, donating, recycling or disposing of an item.");
  renderSuggestions();

  // ---------- Example photos (only shown if the files exist) ----------
  async function setupExamples() {
    const exists = await Promise.all(
      EXAMPLES.map(async (ex) => {
        try {
          const r = await fetch(ex.src, { method: "HEAD" });
          return r.ok && (r.headers.get("content-type") || "").startsWith("image/");
        } catch { return false; }
      })
    );
    const available = EXAMPLES.filter((_, i) => exists[i]);
    if (!available.length) return;
    available.forEach((ex) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.textContent = ex.name;
      btn.addEventListener("click", () => handleExample(ex));
      li.appendChild(btn);
      el.examples.appendChild(li);
    });
    el.examplesBox.hidden = false;
  }

  // ---------- Nav highlight ----------
  function setupNavHighlight() {
    const links = [...document.querySelectorAll(".nav a")];
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          links.forEach((a) => {
            if (a.dataset.section === e.target.id) a.setAttribute("aria-current", "true");
            else a.removeAttribute("aria-current");
          });
        });
      },
      { rootMargin: "-40% 0px -55% 0px" }
    );
    links.forEach((a) => { const s = document.getElementById(a.dataset.section); if (s) obs.observe(s); });
  }

  // ---------- Wiring ----------
  el.input.addEventListener("change", () => handleFile(el.input.files[0]));
  el.dropzone.addEventListener("click", (e) => { if (busy) e.preventDefault(); }); // no file picker mid-scan
  ["dragenter", "dragover"].forEach((evt) =>
    el.dropzone.addEventListener(evt, (e) => { e.preventDefault(); if (!busy) el.dropzone.classList.add("dragover"); })
  );
  ["dragleave", "drop"].forEach((evt) =>
    el.dropzone.addEventListener(evt, (e) => { e.preventDefault(); el.dropzone.classList.remove("dragover"); })
  );
  el.dropzone.addEventListener("drop", (e) => handleFile(e.dataTransfer.files[0]));
  el.analyze.addEventListener("click", analyze);
  el.clear.addEventListener("click", clearAll);
  el.cancel.addEventListener("click", cancelAnalysis);
  el.edit.addEventListener("click", () => { setView("ready"); el.scanner.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" }); });
  document.querySelectorAll(".js-again").forEach((b) =>
    b.addEventListener("click", () => {
      clearAll();
      $("#scan").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    })
  );

  const TOPICS = ["Batteries", "Phones & laptops", "Furniture", "Clothing", "Glass & ceramics", "Safety gear"];
  $("#topic-list").replaceChildren(...TOPICS.map((t) => {
    const li = mk("li"), b = mk("button", "chip", t); b.type = "button";
    b.addEventListener("click", () => sendChat(`What should I do with ${t.toLowerCase()}?`));
    li.append(b); return li;
  }));

  setView("empty");
  setupExamples();
  setupNavHighlight();
  checkBackend();
})();
