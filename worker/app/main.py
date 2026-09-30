"""Worker service: FastAPI (internal only, never published) + the Postgres job loop.

On start: run migrations, then start job threads. Endpoints other than /health require
X-Internal-Token (web is the only caller)."""
from __future__ import annotations

import hmac
import json
import logging
import os
from contextlib import asynccontextmanager

import psycopg
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from . import db, jobs
from .config import settings
from .migrate import run_migrations

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("worker")

TERMINAL = {"done", "failed", "cancelled"}


def _register_handlers() -> None:
    # Importing registers @jobs.handler functions.
    from .agent import run  # noqa: F401
    from .ingest import pipeline  # noqa: F401
    from .mail import resend  # noqa: F401


@asynccontextmanager
async def lifespan(app: FastAPI):
    if os.environ.get("SKIP_MIGRATIONS") != "1":
        applied = run_migrations()
        log.info("migrations applied: %s", applied or "none (up to date)")
        db.reset_pool()
    _register_handlers()
    if os.environ.get("DISABLE_JOB_LOOP") != "1":
        jobs.start()
    yield
    jobs.stop()


app = FastAPI(title="estimates-worker", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


def internal(x_internal_token: str | None = Header(default=None)) -> None:
    expected = settings.internal_token
    if not expected:
        if os.environ.get("ALLOW_NO_INTERNAL_TOKEN") == "1":
            return
        raise HTTPException(503, "INTERNAL_TOKEN not configured")
    if not x_internal_token or not hmac.compare_digest(x_internal_token, expected):
        raise HTTPException(401, "bad internal token")


@app.get("/health")
def health() -> dict:
    out = {"ok": True, "service": "worker", "build": settings.build_hash}
    try:
        row = db.fetchone("""SELECT (SELECT COUNT(*) FROM jobs WHERE status='queued') AS queued,
                                    (SELECT COUNT(*) FROM jobs WHERE status='running') AS running,
                                    (SELECT MAX(version) FROM schema_migrations) AS schema""")
        out.update({"db": "ok", "jobs": {"queued": row["queued"], "running": row["running"]}, "schema": row["schema"]})
    except Exception as e:  # noqa: BLE001
        out.update({"ok": False, "db": f"error: {type(e).__name__}"})
    from .llm import client as llm
    out["llm"] = "available" if llm.available() else "unavailable"
    return out


# ------------------------------------------------------------------ SSE: run events

def _sse(ev: dict) -> str:
    return f"id: {ev['seq']}\nevent: {ev['type']}\ndata: {json.dumps(ev['payload'], default=str)}\n\n"


@app.get("/internal/runs/{run_id}/events", dependencies=[Depends(internal)])
async def run_events(run_id: str, request: Request, after: int = 0,
                     last_event_id: str | None = Header(default=None)):
    """Replay persisted events after `after` (or Last-Event-ID), then tail live ones via LISTEN.
    Closes once the run is terminal and everything has been sent."""
    if last_event_id and last_event_id.isdigit():
        after = max(after, int(last_event_id))
    run = db.fetchone("SELECT id FROM runs WHERE id=%s", (run_id,))
    if not run:
        raise HTTPException(404, "run not found")

    async def gen():
        last, idle = after, 0
        aconn = await psycopg.AsyncConnection.connect(settings.database_url, autocommit=True)
        try:
            await aconn.execute("LISTEN run_events")
            yield "retry: 2000\n\n"
            while True:
                async with aconn.cursor() as cur:
                    await cur.execute("""SELECT seq, type, payload FROM run_events WHERE run_id=%s AND seq > %s
                                         ORDER BY seq LIMIT 500""", (run_id, last))
                    rows = await cur.fetchall()
                    await cur.execute("SELECT status FROM runs WHERE id=%s", (run_id,))
                    st = await cur.fetchone()
                for seq, typ, payload in rows:
                    last = seq
                    yield _sse({"seq": seq, "type": typ, "payload": payload})
                if len(rows) == 500:
                    continue
                if st is None or (st[0] in TERMINAL and not rows):
                    yield "event: end\ndata: {}\n\n"
                    return
                if await request.is_disconnected():
                    return
                # Wake on a NOTIFY for this run, but never wait more than 1 s: a notify that arrived between
                # the query above and this wait would otherwise be missed. Ping every ~15 s of silence.
                woke = False
                async for n in aconn.notifies(timeout=1.0, stop_after=1):
                    woke = woke or n.payload == run_id
                idle = 0 if (rows or woke) else idle + 1
                if idle >= 15:
                    idle = 0
                    yield ": ping\n\n"
        finally:
            await aconn.close()

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})


# ------------------------------------------------------------------ document edits

class RowEdit(BaseModel):
    user_id: str
    qty: float | None = None
    unit: str | None = None
    unit_labour: float | None = None
    unit_material: float | None = None
    norm_h_per_unit: float | None = None
    hourly_rate: float | None = None


@app.post("/internal/documents/{document_id}/rows/{sheet}/{row}", dependencies=[Depends(internal)])
def edit_row(document_id: str, sheet: str, row: int, body: RowEdit):
    from .agent import documents
    from .agent.events import append_event
    changes = body.model_dump(exclude_unset=True)
    user_id = changes.pop("user_id")
    try:
        out = documents.update_row(document_id, sheet, row, changes, user_id)
    except LookupError as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    doc = db.fetchone("SELECT run_id FROM documents WHERE id=%s", (document_id,))
    if doc and doc["run_id"]:
        append_event(str(doc["run_id"]), "document.ready", {"document": out["document"]})
    return JSONResponse(json.loads(json.dumps(out, default=str)))


@app.post("/internal/jobs/wake", dependencies=[Depends(internal)])
def wake() -> dict:
    jobs._wake.set()
    return {"ok": True}


try:
    from .docview.api import router as docview_router
    app.include_router(docview_router)
except ImportError:  # pragma: no cover - docview is optional at import time during development
    log.warning("docview router not available")
