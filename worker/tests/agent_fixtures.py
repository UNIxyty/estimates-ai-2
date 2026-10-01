"""Shared helpers for agent/LLM tests. Import this module FIRST in a test file: it sets the env
before app.config is imported."""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
import uuid

os.environ.setdefault("ESTIMATES_DATABASE_URL", "postgresql://estimates:dev@127.0.0.1:5433/estimates")
os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="est_data_"))
os.environ.setdefault("ALLOW_NO_INTERNAL_TOKEN", "1")
os.environ.setdefault("RESEND_API_KEY", "")

from app import db  # noqa: E402
from app.migrate import run_migrations  # noqa: E402
from app.matching.attributes import parse_attributes  # noqa: E402
from app.matching.text import normalise_text  # noqa: E402
from app.matching.units import normalise_unit  # noqa: E402

_migrated = False


def migrate() -> None:
    global _migrated
    if not _migrated:
        run_migrations()
        db.reset_pool()
        _migrated = True


def uid() -> str:
    return str(uuid.uuid4())


def make_user(role: str = "estimator", send_to: str | None = None) -> dict:
    email = f"u_{uuid.uuid4().hex[:10]}@example.com"
    return db.fetchone("""INSERT INTO users(email, name, role, status, send_estimates_to)
                          VALUES (%s,'Test',%s,'active',%s) RETURNING *""", (email, role, send_to))


def make_conversation(user: dict) -> dict:
    return db.fetchone("INSERT INTO conversations(user_id) VALUES (%s) RETURNING *", (user["id"],))


def make_run(conv: dict, *, allowed: list[str] | None = None, selected: list[str] | None = None,
             cap: float = 2.0, text: str = "hi", attachments: list[str] | None = None) -> dict:
    run = db.fetchone("""INSERT INTO runs(conversation_id, user_id, allowed_file_ids, selected_file_ids,
                                          attachment_ids, cost_cap_usd)
                         VALUES (%s,%s,%s,%s,%s,%s) RETURNING *""",
                      (conv["id"], conv["user_id"], allowed or [], selected or [], attachments or [], cap))
    db.execute("""INSERT INTO messages(conversation_id, run_id, role, content) VALUES (%s,%s,'user',%s)""",
               (conv["id"], run["id"], text))
    return run


def make_file(name: str, tag: str = "reference_estimate", *, items: list[dict] | None = None,
              norms: list[dict] | None = None, language: str = "LV", rate: float | None = None) -> str:
    f = db.fetchone("""INSERT INTO files(original_name, ext, stored_path, tag, status, language, summary)
                       VALUES (%s,'xlsx','/dev/null',%s,'analysed',%s,%s) RETURNING id""",
                    (name, tag, language, db.jsonb({"item_count": len(items or [])})))
    fid = str(f["id"])
    for i, it in enumerate(items or [], start=5):
        text = it["text"]
        attrs = parse_attributes(text)
        db.execute("""INSERT INTO price_items(file_id, sheet_name, row_idx, item_text, item_norm, unit, unit_norm, qty,
                         norm_h_per_unit, unit_labour, unit_material, hourly_rate, attrs, category, embedding)
                      VALUES (%s,'Elektro',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                   (fid, it.get("row", i), text, normalise_text(text), it.get("unit", "m"),
                    normalise_unit(it.get("unit", "m")), it.get("qty", 1), it.get("norm_h"), it.get("labour"),
                    it.get("material"), it.get("rate", rate), db.jsonb(attrs), attrs.get("category"),
                    fake_vector(text) if it.get("embed") else None))
    for n in norms or []:
        db.execute("""INSERT INTO norms(file_id, item_text, item_norm, unit, unit_norm, hours, specificity, params,
                                       attrs, category)
                      VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                   (fid, n["text"], normalise_text(n["text"]), n.get("unit", "pcs"), normalise_unit(n.get("unit", "pcs")),
                    n["hours"], n["specificity"], db.jsonb(n.get("params", {})),
                    db.jsonb(parse_attributes(n["text"])), n.get("category") or parse_attributes(n["text"]).get("category")))
    return fid


def cleanup_files(ids: list[str]) -> None:
    if ids:
        db.execute("DELETE FROM files WHERE id = ANY(%s)", (ids,))


def fake_vector(text: str) -> list[float]:
    """Deterministic 1024-d unit vector from text tokens (bag of hashed tokens)."""
    import math
    v = [0.0] * 1024
    for tok in normalise_text(text).split():
        h = int(hashlib.md5(tok.encode()).hexdigest(), 16)
        v[h % 1024] += 1.0
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


class FakeBody:
    def __init__(self, data: bytes):
        self._d = data

    def read(self) -> bytes:
        return self._d


class FakeBedrock:
    """Scripted bedrock-runtime client. `responses` is a list of callables(req) -> converse response dict,
    or dicts; consumed in order."""

    def __init__(self, responses: list | None = None):
        self.responses = list(responses or [])
        self.requests: list[dict] = []
        self.embed_calls = 0

    def converse(self, **req):
        self.requests.append(req)
        if not self.responses:
            return text_response("ok")
        r = self.responses.pop(0)
        return r(req) if callable(r) else r

    def converse_stream(self, **req):
        resp = self.converse(**req)
        events = [{"messageStart": {"role": "assistant"}}]
        for i, b in enumerate(resp["output"]["message"]["content"]):
            if "text" in b:
                for chunk in [b["text"][j:j + 7] for j in range(0, len(b["text"]), 7)]:
                    events.append({"contentBlockDelta": {"contentBlockIndex": i, "delta": {"text": chunk}}})
            elif "toolUse" in b:
                events.append({"contentBlockStart": {"contentBlockIndex": i, "start": {"toolUse": {
                    "toolUseId": b["toolUse"]["toolUseId"], "name": b["toolUse"]["name"]}}}})
                events.append({"contentBlockDelta": {"contentBlockIndex": i, "delta": {"toolUse": {
                    "input": json.dumps(b["toolUse"]["input"])}}}})
            events.append({"contentBlockStop": {"contentBlockIndex": i}})
        events.append({"messageStop": {"stopReason": resp["stopReason"]}})
        events.append({"metadata": {"usage": resp["usage"]}})
        return {"stream": iter(events)}

    def invoke_model(self, modelId, body, **kw):
        self.embed_calls += 1
        data = json.loads(body)
        texts = data.get("texts") or [data.get("inputText")]
        out = {"embeddings": [fake_vector(t) for t in texts]} if "texts" in data else \
            {"embedding": fake_vector(texts[0]), "inputTextTokenCount": 5}
        return {"body": FakeBody(json.dumps(out).encode()),
                "ResponseMetadata": {"HTTPHeaders": {"x-amzn-bedrock-input-token-count": str(10 * len(texts))}}}


def usage(i=1000, o=200, cr=0, cw=0) -> dict:
    return {"inputTokens": i, "outputTokens": o, "cacheReadInputTokens": cr, "cacheWriteInputTokens": cw}


def text_response(text: str, **u) -> dict:
    return {"output": {"message": {"role": "assistant", "content": [{"text": text}]}}, "stopReason": "end_turn",
            "usage": usage(**u)}


def tool_response(name: str, inp: dict, tool_id: str = "t1", **u) -> dict:
    return {"output": {"message": {"role": "assistant", "content": [
        {"toolUse": {"toolUseId": tool_id, "name": name, "input": inp}}]}},
        "stopReason": "tool_use", "usage": usage(**u)}


def aws_access_denied(operation: str = "Converse") -> Exception:
    """The exception real boto3 raises: a modelled subclass (botocore.errorfactory.AccessDeniedException),
    not a bare ClientError."""
    import boto3
    cls = boto3.client("bedrock-runtime", region_name="eu-north-1").exceptions.AccessDeniedException
    return cls({"Error": {"Code": "AccessDeniedException", "Message": "Model access is denied due to IAM user or "
                "service role is not authorized to perform the required AWS Marketplace actions"}}, operation)


def answer_setup(run_id: str, *, rate=None, sheets=None) -> dict:
    """Answer the fill flow's setup card (hourly rate + sheets) like the user would, then resume the run.
    rate=None accepts the prefilled value. Returns the card that was answered."""
    from app import db as _db
    from app.agent import run as _run
    card = _db.fetchone("SELECT * FROM cards WHERE run_id=%s AND kind='clarify' AND status='pending' "
                        "AND payload->>'purpose'='confirm_setup'", (run_id,))
    assert card, "no pending setup card"
    qs = {q["id"]: q for q in card["payload"]["questions"]}
    answers = {"hourly_rate": rate if rate is not None else qs["hourly_rate"].get("default")}
    if "sheets" in qs:
        answers["sheets"] = sheets if sheets is not None else qs["sheets"].get("suggested")
    _db.execute("UPDATE cards SET status='answered', decision=%s WHERE id=%s",
                (_db.jsonb({"action": "answer", "data": {"answers": answers}}), card["id"]))
    _run.resume_run({"run_id": run_id, "card_id": str(card["id"])})
    return card
