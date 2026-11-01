"""One shared Gemini client, used only by the chatbot (rag.py)."""
import logging
from functools import lru_cache

from google import genai
from google.genai import types

from . import config
from .errors import AppError

log = logging.getLogger("reroute.gemini")


@lru_cache(maxsize=1)
def get_client() -> genai.Client:
    if not config.GEMINI_API_KEY:
        raise AppError("GEMINI_API_KEY is not set. Add it to the .env file in the project root.", 503)
    return genai.Client(
        api_key=config.GEMINI_API_KEY,
        http_options=types.HttpOptions(timeout=config.REQUEST_TIMEOUT_MS),
    )


def translate_error(e: Exception) -> AppError:
    """Turn any SDK / network exception into a clean AppError."""
    code = getattr(e, "code", None)
    log.error("Gemini call failed (%s): %s", code, getattr(e, "message", e))
    if code == 429:
        return AppError("Gemini rate limit reached. Wait a minute and try again.", 429)
    if code in (400, 401, 403, 404):
        return AppError(
            "Gemini rejected the request. Check GEMINI_API_KEY and the model names in .env "
            "(run: python -m backend.check).",
            502,
        )
    if code is not None:
        return AppError("The AI service is temporarily unavailable. Try again shortly.", 502)
    return AppError("Couldn't reach the Gemini API. Check your internet connection.", 502)
