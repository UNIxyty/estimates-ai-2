"""AWS Bedrock Converse client with tool use, prompt caching, streaming, routing, cost ledger,
per-run cost cap and "move up a tier when unsure".

Everything that talks to a model goes through `converse()` (or `complete_json()` on top of it), so
every call is routed, capped and logged in one place.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import dataclass, field
from typing import Any, Callable

from ..config import settings
from . import config_store, ledger, router
from .ledger import Ctx, Usage

log = logging.getLogger(__name__)


class LLMUnavailable(RuntimeError):
    """No model access (disabled, or credentials missing/rejected)."""


class LLMError(RuntimeError):
    pass


class CostCapReached(RuntimeError):
    def __init__(self, spent: float, cap: float, estimate: float):
        super().__init__(f"run cost cap reached: spent ${spent:.4f} + next ≈${estimate:.4f} > cap ${cap:.2f}")
        self.spent, self.cap, self.estimate = spent, cap, estimate


class Cancelled(RuntimeError):
    pass


@dataclass
class LLMResult:
    text: str
    content: list[dict]                 # raw assistant content blocks (replayed verbatim in tool loops)
    tool_uses: list[dict]               # [{id, name, input}]
    stop_reason: str
    usage: Usage
    cost_usd: float
    tier: str
    model_id: str
    task: str
    escalated_from: str | None = None
    calls: int = 1


# ------------------------------------------------------------------ bedrock client

_factory_lock = threading.Lock()
_client = None
_factory: Callable[[], Any] | None = None
_unavailable_reason: str | None = None


def set_bedrock_factory(factory: Callable[[], Any] | None) -> None:
    """Tests inject a fake bedrock-runtime client here."""
    global _client, _factory, _unavailable_reason
    with _factory_lock:
        _factory, _client, _unavailable_reason = factory, None, None


def bedrock():
    global _client
    with _factory_lock:
        if _client is None:
            if _factory is not None:
                _client = _factory()
            else:
                import boto3
                from botocore.config import Config
                _client = boto3.client(
                    "bedrock-runtime", region_name=settings.aws_region,
                    config=Config(retries={"max_attempts": 6, "mode": "adaptive"},
                                  read_timeout=600, connect_timeout=10))
        return _client


def available() -> bool:
    if not settings.llm_enabled or _unavailable_reason:
        return False
    if _factory is not None:
        return True
    try:
        import boto3
        return boto3.Session().get_credentials() is not None
    except Exception:  # noqa: BLE001
        return False


def _mark_unavailable(reason: str) -> None:
    global _unavailable_reason
    _unavailable_reason = reason
    log.error("LLM marked unavailable: %s", reason)


PROMPT_CACHE = os.environ.get("BEDROCK_PROMPT_CACHE", "true").lower() != "false"
CACHE_MIN_CHARS = 4500  # ≈1k+ tokens; shorter prefixes don't cache, so don't add a cache point


# ------------------------------------------------------------------ request building

def _system_blocks(system: str | list[str] | None) -> list[dict]:
    if not system:
        return []
    parts = [system] if isinstance(system, str) else list(system)
    blocks: list[dict] = []
    running = 0
    for i, p in enumerate(parts):
        blocks.append({"text": p})
        running += len(p)
        # Cache point after each stable part that is big enough (max 4 cache points per request).
        if PROMPT_CACHE and running >= CACHE_MIN_CHARS and i < 2:
            blocks.append({"cachePoint": {"type": "default"}})
    return blocks


def _tool_config(tools: list[dict] | None) -> dict | None:
    if not tools:
        return None
    specs: list[dict] = [{"toolSpec": {"name": t["name"], "description": t["description"],
                                       "inputSchema": {"json": t["input_schema"]}}} for t in tools]
    if PROMPT_CACHE:
        specs.append({"cachePoint": {"type": "default"}})
    return {"tools": specs, "toolChoice": {"auto": {}}}


def _approx_chars(system: Any, messages: list[dict], tools: list[dict] | None) -> int:
    return len(json.dumps(system, default=str)) + len(json.dumps(messages, default=str)) + \
        len(json.dumps(tools or [], default=str))


def _check_cap(ctx: Ctx, model_id: str, approx_chars: int, max_tokens: int) -> None:
    if not ctx.run_id:
        return
    spent, cap = ledger.run_cost(ctx.run_id)
    p = config_store.model_price(model_id)
    est = (approx_chars / 3.5) * p.get("input", 0) / 1e6 + min(max_tokens, 2000) * p.get("output", 0) / 1e6
    if spent + est > cap:
        raise CostCapReached(spent, cap, est)


def _usage_from(u: dict | None) -> Usage:
    u = u or {}
    return Usage(input_tokens=int(u.get("inputTokens", 0) or 0),
                 output_tokens=int(u.get("outputTokens", 0) or 0),
                 cache_read_tokens=int(u.get("cacheReadInputTokens", 0) or 0),
                 cache_write_tokens=int(u.get("cacheWriteInputTokens", 0) or 0))


def _handle_client_error(e: Exception) -> None:
    code = getattr(e, "response", {}).get("Error", {}).get("Code", "") if hasattr(e, "response") else ""
    if code in ("UnrecognizedClientException", "AccessDeniedException", "InvalidSignatureException",
                "ExpiredTokenException"):
        _mark_unavailable(f"{code}: {e}")
        raise LLMUnavailable(str(e)) from e
    raise LLMError(str(e)) from e


# ------------------------------------------------------------------ one call

def _call(model_id: str, system_blocks: list[dict], messages: list[dict], tool_config: dict | None,
          max_tokens: int, on_text: Callable[[str], None] | None,
          should_stop: Callable[[], bool] | None) -> tuple[list[dict], str, Usage]:
    req: dict[str, Any] = {"modelId": model_id, "messages": messages,
                           "inferenceConfig": {"maxTokens": max_tokens}}
    if system_blocks:
        req["system"] = system_blocks
    if tool_config:
        req["toolConfig"] = tool_config
    client = bedrock()
    try:
        if on_text is None:
            resp = client.converse(**req)
            content = resp.get("output", {}).get("message", {}).get("content", [])
            return content, resp.get("stopReason", "end_turn"), _usage_from(resp.get("usage"))
        resp = client.converse_stream(**req)
    except LLMUnavailable:
        raise
    except Exception as e:  # noqa: BLE001
        if type(e).__name__ in ("ClientError", "NoCredentialsError", "EventStreamError"):
            if type(e).__name__ == "NoCredentialsError":
                _mark_unavailable(str(e))
                raise LLMUnavailable(str(e)) from e
            _handle_client_error(e)
        raise

    # Streaming: rebuild the content blocks as Converse would have returned them.
    blocks: dict[int, dict] = {}
    stop_reason, usage = "end_turn", Usage()
    for event in resp["stream"]:
        if should_stop and should_stop():
            raise Cancelled()
        if "contentBlockStart" in event:
            ev = event["contentBlockStart"]
            start = ev.get("start", {})
            if "toolUse" in start:
                blocks[ev["contentBlockIndex"]] = {"toolUse": {**start["toolUse"], "_input": ""}}
        elif "contentBlockDelta" in event:
            ev = event["contentBlockDelta"]
            idx, delta = ev["contentBlockIndex"], ev["delta"]
            if "text" in delta:
                b = blocks.setdefault(idx, {"text": ""})
                b["text"] += delta["text"]
                on_text(delta["text"])
            elif "toolUse" in delta:
                b = blocks.setdefault(idx, {"toolUse": {"_input": ""}})
                b["toolUse"]["_input"] += delta["toolUse"].get("input", "")
            elif "reasoningContent" in delta:
                b = blocks.setdefault(idx, {"reasoningContent": {"reasoningText": {"text": ""}}})
                rc = delta["reasoningContent"]
                if "text" in rc:
                    b["reasoningContent"]["reasoningText"]["text"] += rc["text"]
                if "signature" in rc:
                    b["reasoningContent"]["reasoningText"]["signature"] = rc["signature"]
                if "redactedContent" in rc:
                    blocks[idx] = {"reasoningContent": {"redactedContent": rc["redactedContent"]}}
        elif "messageStop" in event:
            stop_reason = event["messageStop"].get("stopReason", "end_turn")
        elif "metadata" in event:
            usage = _usage_from(event["metadata"].get("usage"))
    content: list[dict] = []
    for idx in sorted(blocks):
        b = blocks[idx]
        if "toolUse" in b:
            raw = b["toolUse"].pop("_input", "")
            try:
                b["toolUse"]["input"] = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                b["toolUse"]["input"] = {"_invalid_json": raw}
        content.append(b)
    return content, stop_reason, usage


def converse(*, task: str, messages: list[dict], ctx: Ctx, system: str | list[str] | None = None,
             tools: list[dict] | None = None, max_tokens: int = 4096, forced_tier: str | None = None,
             on_text: Callable[[str], None] | None = None,
             should_stop: Callable[[], bool] | None = None,
             unsure: Callable[[LLMResult], bool] | None = None,
             meta: dict | None = None) -> LLMResult:
    """Route → cap check → call → ledger. If `unsure(result)` is true on a Fast answer and the
    "move up a tier when unsure" toggle is on, retry once on the next tier up (logged)."""
    if not available():
        raise LLMUnavailable(_unavailable_reason or "LLM disabled or no AWS credentials")
    routing = config_store.routing()
    route = router.resolve(task, forced_tier=forced_tier, routing=routing)
    sys_blocks = _system_blocks(system)
    tool_cfg = _tool_config(tools)
    approx = _approx_chars(system, messages, tools)

    def attempt(tier: str, model_id: str, escalated_from: str | None,
                text_cb: Callable[[str], None] | None) -> LLMResult:
        _check_cap(ctx, model_id, approx, max_tokens)
        content, stop, usage = _call(model_id, sys_blocks, messages, tool_cfg, max_tokens, text_cb, should_stop)
        cost = ledger.record(ctx=ctx, kind="llm", task=task, tier=tier, model_id=model_id, usage=usage,
                             escalated_from=escalated_from,
                             meta={**(meta or {}), "stop_reason": stop,
                                   **({"override": True} if route.overridden else {})})
        text = "".join(b.get("text", "") for b in content if "text" in b)
        tool_uses = [{"id": b["toolUse"].get("toolUseId"), "name": b["toolUse"].get("name"),
                      "input": b["toolUse"].get("input", {})} for b in content if "toolUse" in b]
        return LLMResult(text, content, tool_uses, stop, usage, cost, tier, model_id, task, escalated_from)

    result = attempt(route.tier, route.model_id, None, on_text if unsure is None else None)
    if unsure is not None:
        escalate = (route.tier == "fast" and routing.get("escalate_when_unsure", True)
                    and forced_tier is None and unsure(result))
        if escalate:
            up = router.next_tier_up("fast", routing)
            if up:
                log.info("escalating %s from fast to %s", task, up)
                first = result
                result = attempt(up, routing["tiers"][up]["model_id"], "fast", on_text)
                result.usage.add(first.usage)
                result.cost_usd = round(result.cost_usd + first.cost_usd, 6)
                result.calls = 2
                return result
        if on_text and result.text:
            on_text(result.text)
    return result


# ------------------------------------------------------------------ JSON helper

def complete_json(task: str, system: str, prompt: str, schema: dict, *, ctx: Ctx | None = None,
                  file_id: str | None = None, user_id: str | None = None, forced_tier: str | None = None,
                  max_tokens: int = 4096, cached_context: str | None = None) -> dict:
    """Ask for structured output through a single `emit` tool (tool_choice auto + instruction:
    forced tool choice is rejected by the newest models). If the schema has a numeric `confidence`
    and a Fast answer comes back below 0.6, it is retried one tier up."""
    ctx = ctx or Ctx(user_id=user_id, file_id=file_id)
    tool = {"name": "emit", "description": "Return the result. Always call this exactly once.",
            "input_schema": schema}
    content: list[dict] = []
    if cached_context:
        content.append({"text": cached_context})
        if PROMPT_CACHE and len(cached_context) >= CACHE_MIN_CHARS:
            content.append({"cachePoint": {"type": "default"}})
    content.append({"text": prompt + "\n\nRespond by calling the `emit` tool once with the result."})
    messages = [{"role": "user", "content": content}]

    def parse(res: LLMResult) -> dict | None:
        for tu in res.tool_uses:
            if tu["name"] == "emit" and isinstance(tu["input"], dict) and "_invalid_json" not in tu["input"]:
                return tu["input"]
        txt = res.text.strip()
        if txt.startswith("```"):
            txt = txt.strip("`").split("\n", 1)[-1]
        try:
            start, end = txt.index("{"), txt.rindex("}") + 1
            return json.loads(txt[start:end])
        except (ValueError, json.JSONDecodeError):
            return None

    def unsure(res: LLMResult) -> bool:
        out = parse(res)
        if out is None:
            return True
        conf = out.get("confidence")
        return isinstance(conf, (int, float)) and conf < 0.6

    has_conf = "confidence" in (schema.get("properties") or {})
    res = converse(task=task, messages=messages, ctx=ctx, system=system, tools=[tool], max_tokens=max_tokens,
                   forced_tier=forced_tier, unsure=unsure if has_conf else None)
    out = parse(res)
    if out is None:
        raise LLMError(f"model returned no structured output for task {task}")
    return out
