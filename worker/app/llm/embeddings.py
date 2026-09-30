"""Multilingual embeddings via Bedrock InvokeModel (Cohere Embed Multilingual v3 by default,
Amazon Titan Text Embeddings v2 supported). 1024 dimensions, matching the vector(1024) columns.
Every call is logged in the usage ledger (kind='embedding')."""
from __future__ import annotations

import json
import logging

from ..config import settings
from . import client as llm
from . import ledger
from .ledger import Ctx, Usage

log = logging.getLogger(__name__)
COHERE_BATCH = 96


def _invoke(model_id: str, body: dict) -> tuple[dict, int | None]:
    resp = llm.bedrock().invoke_model(modelId=model_id, body=json.dumps(body),
                                      contentType="application/json", accept="application/json")
    headers = (resp.get("ResponseMetadata") or {}).get("HTTPHeaders") or {}
    tok = headers.get("x-amzn-bedrock-input-token-count")
    raw = resp["body"].read() if hasattr(resp["body"], "read") else resp["body"]
    return json.loads(raw), int(tok) if tok else None


def embed_texts(texts: list[str], *, input_type: str = "search_document", file_id: str | None = None,
                user_id: str | None = None, ctx: Ctx | None = None,
                model_id: str | None = None) -> list[list[float]] | None:
    """Returns one 1024-d vector per text, or None when embeddings are unavailable
    (callers must work without them: exact/attribute/norm matching still runs)."""
    if not texts:
        return []
    if not llm.available():
        return None
    ctx = ctx or Ctx(user_id=user_id, file_id=file_id)
    model_id = model_id or settings.embedding_model
    clean = [(t or " ")[:2000] for t in texts]
    out: list[list[float]] = []
    try:
        if model_id.startswith("cohere."):
            for i in range(0, len(clean), COHERE_BATCH):
                batch = clean[i:i + COHERE_BATCH]
                data, tokens = _invoke(model_id, {"texts": batch, "input_type": input_type, "truncate": "END"})
                out.extend(data["embeddings"] if isinstance(data["embeddings"], list)
                           else data["embeddings"]["float"])
                ledger.record(ctx=ctx, kind="embedding", task="embed", tier=None, model_id=model_id,
                              usage=Usage(input_tokens=tokens or sum(len(t) for t in batch) // 4),
                              meta={"texts": len(batch), "estimated_tokens": tokens is None})
        else:  # amazon.titan-embed-text-v2:0 — one text per call
            total = 0
            for t in clean:
                data, _ = _invoke(model_id, {"inputText": t, "dimensions": settings.embedding_dim,
                                             "normalize": True})
                out.append(data["embedding"])
                total += int(data.get("inputTextTokenCount", len(t) // 4))
            ledger.record(ctx=ctx, kind="embedding", task="embed", tier=None, model_id=model_id,
                          usage=Usage(input_tokens=total), meta={"texts": len(clean)})
    except llm.LLMUnavailable:
        return None
    except Exception as e:  # noqa: BLE001
        if type(e).__name__ == "ClientError":
            code = e.response.get("Error", {}).get("Code", "")  # type: ignore[attr-defined]
            if code in ("UnrecognizedClientException", "AccessDeniedException"):
                llm._mark_unavailable(str(e))
                return None
        log.exception("embedding call failed")
        raise
    if any(len(v) != settings.embedding_dim for v in out):
        raise ValueError(f"embedding model {model_id} returned wrong dimension; need {settings.embedding_dim}")
    return out


def embed_query(text: str, *, ctx: Ctx | None = None) -> list[float] | None:
    res = embed_texts([text], input_type="search_query", ctx=ctx)
    return res[0] if res else None
