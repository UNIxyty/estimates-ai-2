"""Routing, price table and budget settings: stored in the `settings` table (edited on
/settings/routing), with defaults from env. Cached briefly so hot paths don't hit the DB per call."""
from __future__ import annotations

import threading
import time
from copy import deepcopy

from .. import db
from ..config import settings

TIERS = ("fast", "standard", "advanced")

DEFAULT_TASKS: dict[str, str] = {
    "simple_question": "fast",
    "short_reply": "fast",
    "email": "fast",
    "classify": "fast",
    "file_analysis": "standard",
    "fill_blank": "standard",
    "web_search": "standard",
    "generate": "advanced",
    "complex_reasoning": "advanced",
}

# USD per 1M tokens. Defaults are Anthropic list prices for the model families; Bedrock pricing is
# set by AWS per region, so verify against https://aws.amazon.com/bedrock/pricing/ and edit these
# on /settings/routing. Keys are matched exactly first, then by family substring.
DEFAULT_MODEL_PRICES: dict[str, dict[str, float]] = {
    "claude-haiku-4-5": {"input": 1.00, "output": 5.00, "cache_read": 0.10, "cache_write": 1.25},
    "claude-sonnet-5-5": {"input": 2.00, "output": 10.00, "cache_read": 0.20, "cache_write": 2.50},
    "claude-opus-5-5": {"input": 4.00, "output": 20.00, "cache_read": 0.20, "cache_write": 5.00},
    "claude-sonnet-4-5": {"input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_write": 3.75},
    "claude-opus-4-1": {"input": 15.00, "output": 75.00, "cache_read": 1.50, "cache_write": 18.75},
    "cohere.embed-multilingual-v3": {"input": 0.10, "output": 0.0, "cache_read": 0.0, "cache_write": 0.0},
    "amazon.titan-embed-text-v2": {"input": 0.02, "output": 0.0, "cache_read": 0.0, "cache_write": 0.0},
}

_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()
TTL = 10.0


def _load(key: str) -> dict | None:
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < TTL:
            return deepcopy(hit[1])
    row = db.fetchone("SELECT value FROM settings WHERE key=%s", (key,))
    value = row["value"] if row else None
    with _lock:
        _cache[key] = (now, value)
    return deepcopy(value)


def invalidate() -> None:
    with _lock:
        _cache.clear()


def default_routing() -> dict:
    return {
        "tiers": {
            "fast": {"model_id": settings.model_fast, "enabled": True},
            "standard": {"model_id": settings.model_standard, "enabled": True},
            "advanced": {"model_id": settings.model_advanced, "enabled": True},
        },
        "tasks": dict(DEFAULT_TASKS),
        "overrides": {},
        "escalate_when_unsure": True,
    }


def routing() -> dict:
    base = default_routing()
    stored = _load("routing") or {}
    for tier, cfg in (stored.get("tiers") or {}).items():
        if tier in base["tiers"] and isinstance(cfg, dict):
            base["tiers"][tier].update({k: v for k, v in cfg.items() if v not in (None, "")})
    base["tasks"].update(stored.get("tasks") or {})
    base["overrides"] = dict(stored.get("overrides") or {})
    if "escalate_when_unsure" in stored:
        base["escalate_when_unsure"] = bool(stored["escalate_when_unsure"])
    return base


def prices() -> dict:
    stored = _load("prices") or {}
    models = dict(DEFAULT_MODEL_PRICES)
    models.update(stored.get("models") or {})
    return {
        "models": models,
        "web_search_unit_usd": float(stored.get("web_search_unit_usd", settings.web_search_unit_cost_usd)),
    }


def model_price(model_id: str) -> dict[str, float]:
    table = prices()["models"]
    if model_id in table:
        return table[model_id]
    # Inference-profile prefixes (eu./us./global.) and version suffixes vary; match by family.
    best = None
    for key, p in table.items():
        if key in model_id and (best is None or len(key) > len(best[0])):
            best = (key, p)
    return best[1] if best else {"input": 0.0, "output": 0.0, "cache_read": 0.0, "cache_write": 0.0}


def budget() -> dict:
    stored = _load("budget") or {}
    return {
        "monthly_usd": float(stored.get("monthly_usd", 0) or 0),
        "alert_pct": int(stored.get("alert_pct", 80) or 80),
        "over_action": stored.get("over_action", "warn"),
    }
