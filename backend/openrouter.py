"""OpenRouter client (OpenAI-compatible chat completions): one call for vision, one for streaming chat."""
import asyncio
import json
import logging

import httpx

from . import config
from .errors import AppError

log = logging.getLogger("reroute.openrouter")
RETRYABLE = {500, 502, 503, 504, 524, 529}


def _headers() -> dict:
    if not config.OPENROUTER_API_KEY:
        raise AppError("OPENROUTER_API_KEY is not set. Add it to the .env file in the project root.", 503)
    return {"Authorization": f"Bearer {config.OPENROUTER_API_KEY}", "Content-Type": "application/json", "X-Title": "ReRoute AI"}


def _error(status: int, detail: str = "") -> AppError:
    log.error("OpenRouter error %s: %s", status, detail[:300])
    if status in (401, 403):
        return AppError("OpenRouter rejected your API key. Check OPENROUTER_API_KEY in .env.", 502)
    if status == 402:
        return AppError("Your OpenRouter account has no credits for this request.", 502)
    if status == 429:
        return AppError("The free AI models are busy or the free limit was reached. Wait a minute and try again.", 429)
    if status in (400, 404):
        return AppError("OpenRouter rejected the request. Check LLM_MODEL in .env (run: python -m backend.check).", 502)
    return AppError("The AI service is temporarily unavailable. Try again shortly.", 502)


def _text(message: dict) -> str:
    content = message.get("content")
    if isinstance(content, list):
        content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return (content or "").strip()


async def complete(messages: list, *, reasoning: bool = False, temperature: float = 0.0,
                   max_tokens: int = 0, attempts: int = 2) -> str:
    """One chat completion; returns the answer text. Retries once on server errors / empty answers."""
    body = {"model": config.LLM_MODEL, "messages": messages, "temperature": temperature}
    if reasoning:
        body["reasoning"] = {"enabled": True}
    if max_tokens:
        body["max_tokens"] = max_tokens
    last = AppError("The AI model returned an empty answer. Try again.", 502)
    for attempt in range(attempts):
        if attempt:
            await asyncio.sleep(0.8)
        try:
            async with httpx.AsyncClient(timeout=config.REQUEST_TIMEOUT_S) as client:
                r = await client.post(f"{config.OPENROUTER_BASE_URL}/chat/completions", headers=_headers(), json=body)
        except httpx.HTTPError as e:
            log.error("Network error: %s", e)
            last = AppError("Couldn't reach OpenRouter. Check your internet connection.", 502)
            continue
        if r.status_code != 200:
            last = _error(r.status_code, r.text)
            if r.status_code in RETRYABLE:
                continue
            raise last
        try:
            data = r.json()
        except ValueError:
            continue
        if data.get("error"):
            code = int(data["error"].get("code") or 502)
            last = _error(code, json.dumps(data["error"]))
            if code in RETRYABLE:
                continue
            raise last
        text = _text((data.get("choices") or [{}])[0].get("message") or {})
        if text:
            return text
    raise last


async def stream(messages: list, *, temperature: float = 0.3, max_tokens: int = 700):
    """Yield the answer text piece by piece (server-sent events from OpenRouter)."""
    body = {"model": config.LLM_MODEL, "messages": messages, "temperature": temperature,
            "max_tokens": max_tokens, "stream": True}
    got = False
    try:
        async with httpx.AsyncClient(timeout=config.REQUEST_TIMEOUT_S) as client:
            async with client.stream("POST", f"{config.OPENROUTER_BASE_URL}/chat/completions",
                                     headers=_headers(), json=body) as r:
                if r.status_code != 200:
                    await r.aread()
                    raise _error(r.status_code, r.text)
                async for line in r.aiter_lines():
                    if not line.startswith("data:"):
                        continue  # skips keep-alive comments like ": OPENROUTER PROCESSING"
                    chunk = line[5:].strip()
                    if chunk == "[DONE]":
                        break
                    try:
                        j = json.loads(chunk)
                    except ValueError:
                        continue
                    if j.get("error"):
                        raise _error(int(j["error"].get("code") or 502), json.dumps(j["error"]))
                    piece = ((j.get("choices") or [{}])[0].get("delta") or {}).get("content")
                    if piece:
                        got = True
                        yield piece
    except httpx.HTTPError as e:
        log.error("Network error while streaming: %s", e)
        raise AppError("Couldn't reach OpenRouter. Check your internet connection.", 502)
    if not got:
        raise AppError("The AI model returned an empty answer. Try again.", 502)
