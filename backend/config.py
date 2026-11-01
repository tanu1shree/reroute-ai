"""Settings, loaded from the .env file in the project root (next to requirements.txt)."""
import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "backend" / "data"
load_dotenv(BASE_DIR / ".env")


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip().strip('"').strip("'")  # tolerate spaces/quotes


def _num(name: str, default: float) -> float:
    try:
        return float(_env(name, str(default)))
    except ValueError:
        return default


OPENROUTER_API_KEY = _env("OPENROUTER_API_KEY")
OPENROUTER_BASE_URL = _env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").rstrip("/")
LLM_MODEL = _env("LLM_MODEL", "openrouter/free")
VISION_MODEL = LLM_MODEL

CHAT_PROVIDER = _env("CHAT_PROVIDER", "auto").lower()
MIN_ITEM_CONFIDENCE = _num("MIN_ITEM_CONFIDENCE", 0.2)
RATE_LIMIT_PER_MIN = int(_num("RATE_LIMIT_PER_MIN", 20))  # per visitor IP
REQUEST_TIMEOUT_S = _num("REQUEST_TIMEOUT_S", 90)
RAG_TOP_K = 4
