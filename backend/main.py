"""The web server. Three jobs:
  POST /api/analyze  photo (+ optional condition / works) -> item, route, reason, next step
  POST /api/chat     question (+ scanned item + history)  -> grounded answer with sources
  GET  /api/health   is everything loaded?
It also serves the website in frontend/ so you run ONE server and open ONE address.
"""
import json
import logging
import time
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from . import config, rag, recommendation, vision
from .errors import AppError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("reroute.api")

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
MAX_SIZE_BYTES = 10 * 1024 * 1024  # 10 MB
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp"}
CONDITIONS = {"good", "worn", "damaged", "unknown"}


app = FastAPI(title="ReRoute AI")


_hits: dict = {}


@app.middleware("http")
async def rate_limit(request: Request, call_next):
    """Tiny per-IP limiter so a public deployment can't drain your free API quota."""
    if request.url.path.startswith("/api/") and request.url.path != "/api/health" and config.RATE_LIMIT_PER_MIN > 0:
        ip = (request.headers.get("x-forwarded-for") or (request.client.host if request.client else "?")).split(",")[0].strip()
        now = time.time()
        q = [t for t in _hits.get(ip, []) if now - t < 60]
        if len(q) >= config.RATE_LIMIT_PER_MIN:
            return JSONResponse(status_code=429, content={"detail": "Too many requests. Please wait a minute."})
        q.append(now)
        _hits[ip] = q
    return await call_next(request)


@app.exception_handler(AppError)
async def app_error_handler(request: Request, exc: AppError):
    return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)})


# ---------------- models ----------------
class Candidate(BaseModel):
    item: str
    confidence: float


class AnalysisResponse(BaseModel):
    item: str
    category: str
    condition: str
    condition_source: Literal["you", "ai"]
    confidence: float
    candidates: list[Candidate]
    pathway: str
    reason: str
    next_action: str
    alternative: str
    rule_id: str


class ChatItem(BaseModel):
    item: str = Field(max_length=100)
    category: Optional[str] = Field(default=None, max_length=40)
    condition: Optional[str] = Field(default=None, max_length=40)
    confidence: Optional[float] = None
    pathway: Optional[str] = Field(default=None, max_length=40)
    reason: Optional[str] = Field(default=None, max_length=700)
    next_action: Optional[str] = Field(default=None, max_length=500)
    alternative: Optional[str] = Field(default=None, max_length=500)


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=1500)


class ChatRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    question: str = Field(min_length=1, max_length=500)
    item: Optional[ChatItem] = None
    history: list[ChatTurn] = Field(default_factory=list, max_length=20)


class ChatSource(BaseModel):
    id: str
    title: str


class ChatResponse(BaseModel):
    answer: str
    sources: list[ChatSource]
    mode: Literal["ai", "local", "fallback"]


# ---------------- helpers ----------------
def sniff_image_type(data: bytes) -> Optional[str]:
    """Identify the real image format from its first bytes (the Content-Type header can lie)."""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def parse_condition(value: Optional[str]) -> Optional[str]:
    if value is None or not value.strip():
        return None
    v = value.strip().lower()
    if v in ("not sure", "not_sure", "unsure"):
        v = "unknown"
    if v not in CONDITIONS:
        raise HTTPException(status_code=400, detail="'condition' must be good, worn, damaged or unknown.")
    return v


def parse_works(value: Optional[str]) -> Optional[bool]:
    if value is None or not value.strip():
        return None
    v = value.strip().lower()
    if v in ("yes", "true"):
        return True
    if v in ("no", "false"):
        return False
    if v in ("unknown", "not sure", "unsure"):
        return None
    raise HTTPException(status_code=400, detail="'works' must be yes, no or unknown.")


# ---------------- routes ----------------
@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "vision_model": config.VISION_MODEL,
        "vision_ready": vision.is_ready(),
        "chat_mode": rag.chat_mode(),
    }


@app.post("/api/analyze", response_model=AnalysisResponse)
async def analyze(
    file: UploadFile = File(...),
    condition: Optional[str] = Form(None),
    works: Optional[str] = Form(None),
):
    user_condition = parse_condition(condition)
    functional = parse_works(works)

    # 1. Validate the upload
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(status_code=415, detail="Upload a JPEG, PNG, or WebP image.")
    image_bytes = await file.read(MAX_SIZE_BYTES + 1)  # never read more than the limit + 1 byte
    if not image_bytes:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    if len(image_bytes) > MAX_SIZE_BYTES:
        raise HTTPException(status_code=413, detail="Image too large (max 10 MB).")
    mime = sniff_image_type(image_bytes)
    if mime is None:
        raise HTTPException(status_code=400, detail="That file is not a valid JPEG, PNG, or WebP image.")

    # 2. Computer vision (vision AI model)
    try:
        assessment = await vision.analyze_image(image_bytes, mime)
    except AppError:
        raise
    except Exception:
        log.exception("Unexpected error during vision")
        raise HTTPException(status_code=500, detail="Something went wrong while analysing the image.")
    if assessment["item"] == "unidentified":
        raise HTTPException(
            status_code=422,
            detail="Couldn't recognise a household item in this photo. Try a closer, well-lit photo of a single item.",
        )

    # 3. Condition: the AI's estimate, unless the user corrected it
    condition_source = "ai"
    if user_condition and user_condition != "unknown":
        assessment["condition"] = user_condition
        condition_source = "you"

    # 4. Decision engine (rules)
    advice = recommendation.recommend(assessment, functional)
    return {**assessment, "condition_source": condition_source, **advice}


@app.post("/api/chat/stream")
async def chat_stream(req: ChatRequest):
    """Same as /api/chat but streams the answer as server-sent events."""
    item = req.item.model_dump() if req.item else None
    history = [t.model_dump() for t in req.history]

    async def events():
        try:
            async for ev in rag.stream_answer(req.question, item, history):
                yield f"data: {json.dumps(ev)}\n\n"
        except Exception:
            log.exception("Unexpected error during chat stream")
            yield f"data: {json.dumps({'type': 'fallback', 'mode': 'fallback', 'text': 'Something went wrong while answering.'})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    try:
        return await rag.answer(
            req.question,
            req.item.model_dump() if req.item else None,
            [t.model_dump() for t in req.history],
        )
    except AppError:
        raise
    except Exception:
        log.exception("Unexpected error during chat")
        raise HTTPException(status_code=500, detail="Something went wrong while answering.")


app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
