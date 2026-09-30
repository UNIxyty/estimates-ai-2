"""Model router: rules first, then a Fast-tier classification call for free-text chat.

Resolution order for a task's tier:
  1. forced tier (budget "Allow Fast tier only" → fast)
  2. per-task override (shown with an OVERRIDE marker on /settings/routing)
  3. default task map
  4. a disabled tier sends its tasks up a tier (fast → standard → advanced); if nothing above is
     enabled, the nearest enabled tier below is used.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from . import config_store
from .config_store import TIERS


@dataclass(frozen=True)
class Route:
    task: str
    tier: str
    model_id: str
    overridden: bool = False
    moved_from: str | None = None  # tier was disabled, moved up/down from this


def resolve(task: str, *, forced_tier: str | None = None, routing: dict | None = None) -> Route:
    cfg = routing or config_store.routing()
    tiers = cfg["tiers"]
    overridden = False
    if forced_tier in TIERS:
        tier = forced_tier
        return Route(task, tier, tiers[tier]["model_id"], overridden=False)
    if task in cfg.get("overrides", {}) and cfg["overrides"][task] in TIERS:
        tier, overridden = cfg["overrides"][task], True
    else:
        tier = cfg["tasks"].get(task, "standard")
    moved_from = None
    if not tiers[tier].get("enabled", True):
        moved_from = tier
        i = TIERS.index(tier)
        up = [t for t in TIERS[i + 1:] if tiers[t].get("enabled", True)]
        down = [t for t in reversed(TIERS[:i]) if tiers[t].get("enabled", True)]
        if up:
            tier = up[0]
        elif down:
            tier = down[0]
        else:
            raise RuntimeError("All model tiers are turned off in routing settings")
    return Route(task, tier, tiers[tier]["model_id"], overridden, moved_from)


def next_tier_up(tier: str, routing: dict | None = None) -> str | None:
    cfg = routing or config_store.routing()
    i = TIERS.index(tier)
    for t in TIERS[i + 1:]:
        if cfg["tiers"][t].get("enabled", True):
            return t
    return None


# ------------------------------------------------------------------ free-text classification

_EMAIL = re.compile(r"\b(send|e-?mail|mail me|nosūt|nosut|e-?pasts?|epast|send mig|mail)\b", re.I)
_WHY = re.compile(r"\b(why|kāpēc|kapec|hvorfor|explain|paskaidro|how come)\b", re.I)
_GENERATE = re.compile(r"\b(generate|create|make|build|sagatavo|izveido|uztaisi|lav|opret)\b.*\b(estimate|tāme|tame|budget|tilbud|overslag)\b", re.I)
_LIST_LINE = re.compile(r"^\s*(\d+[.)]|[-•*])\s+\S", re.M)


def classify_rules(text: str, *, has_xlsx_attachment: bool, has_list_attachment: bool,
                   has_document: bool) -> str | None:
    """Return a task when the rules can decide, else None (→ Fast classification call)."""
    t = text.strip()
    if has_xlsx_attachment:
        return "fill_blank"
    if has_list_attachment:
        return "generate"
    if _EMAIL.search(t) and has_document and len(t) < 200:
        return "email"
    if len(_LIST_LINE.findall(t)) >= 3 or _GENERATE.search(t):
        return "generate"
    if _WHY.search(t) and has_document:
        return "complex_reasoning"
    if len(t) < 60 and not has_document:
        return "short_reply"
    return None


CLASSIFY_SCHEMA = {
    "type": "object",
    "properties": {
        "task": {"type": "string", "enum": ["simple_question", "short_reply", "complex_reasoning",
                                            "generate", "email"]},
        "confidence": {"type": "number"},
    },
    "required": ["task", "confidence"],
    "additionalProperties": False,
}

CLASSIFY_SYSTEM = (
    "You route messages in an electrical-estimating assistant. Pick the task type:\n"
    "simple_question: a factual question answerable from stored estimate data (a row's price, a total).\n"
    "short_reply: greetings, thanks, confirmations, one-line chit-chat.\n"
    "complex_reasoning: comparisons, explanations of why a price is what it is across several rows, "
    "what-if changes, anything needing multi-step reasoning.\n"
    "generate: the user gives a work list (in the message) and wants a new estimate built.\n"
    "email: the user wants the current estimate sent to them by email.\n"
    "Return JSON only."
)
