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

# USD per 1M tokens: AWS Bedrock on-demand prices for eu-north-1 (Stockholm), from the AWS price list API
# (2026-10-01). eu.* inference profiles bill at the "Regional" rate (list price + 10%); cache_write is the
# 5-minute cache. Edit on /settings/routing if AWS changes them. Keys are matched exactly first, then by
# family substring, so eu.anthropic.claude-opus-4-6-v1 resolves to "claude-opus-4-6".
DEFAULT_MODEL_PRICES: dict[str, dict[str, float]] = {
    "claude-haiku-4-5": {"input": 1.10, "output": 5.50, "cache_read": 0.11, "cache_write": 1.375},
    "claude-sonnet-4-6": {"input": 3.30, "output": 16.50, "cache_read": 0.33, "cache_write": 4.125},
    "claude-opus-4-6": {"input": 5.50, "output": 27.50, "cache_read": 0.55, "cache_write": 6.875},
    "amazon.titan-embed-text-v2": {"input": 0.021, "output": 0.0, "cache_read": 0.0, "cache_write": 0.0},
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
