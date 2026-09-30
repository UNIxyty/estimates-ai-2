"""Postgres job queue: SELECT … FOR UPDATE SKIP LOCKED, no extra broker.

Handlers register with @handler("kind"). The loop runs N worker threads; each claims one job at a time.
A LISTEN on channel `jobs` wakes idle threads immediately; otherwise they poll every POLL_SECONDS.
"""
from __future__ import annotations

import logging
import os
import socket
import threading
import time
import traceback
from typing import Any, Callable

import psycopg

from . import db
from .config import settings

log = logging.getLogger(__name__)
POLL_SECONDS = 2.0
STALE_MINUTES = 15
WORKER_ID = f"{socket.gethostname()}:{os.getpid()}"

_handlers: dict[str, Callable[[dict], Any]] = {}
_wake = threading.Event()
_stop = threading.Event()


def handler(kind: str):
    def deco(fn: Callable[[dict], Any]):
        _handlers[kind] = fn
        return fn
    return deco


class RetryLater(Exception):
    """Raise from a handler to requeue without counting as failure (e.g. waiting on something)."""
    def __init__(self, seconds: float = 5.0):
        super().__init__(f"retry in {seconds}s")
        self.seconds = seconds


def enqueue(kind: str, payload: dict, *, dedupe_key: str | None = None, delay_seconds: float = 0,
            max_attempts: int = 3, connection: psycopg.Connection | None = None) -> int | None:
    """Insert a job. With dedupe_key, a second enqueue while one is queued/running is a no-op."""
    sql = """INSERT INTO jobs(kind, payload, dedupe_key, run_after, max_attempts)
             VALUES (%s, %s, %s, now() + make_interval(secs => %s), %s)
             ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','running')
             DO NOTHING RETURNING id"""
    params = (kind, db.jsonb(payload), dedupe_key, delay_seconds, max_attempts)
    if connection is not None:
        row = connection.execute(sql, params).fetchone()
        connection.execute("SELECT pg_notify('jobs', %s)", (kind,))
    else:
        with db.conn() as c:
            row = c.execute(sql, params).fetchone()
            c.execute("SELECT pg_notify('jobs', %s)", (kind,))
            c.commit()
    return row["id"] if row else None


def claim(kinds: list[str] | None = None) -> dict | None:
    kinds = kinds or list(_handlers)
    return db.fetchone(
        """UPDATE jobs SET status='running', locked_at=now(), locked_by=%s, attempts=attempts+1
           WHERE id = (SELECT id FROM jobs
                        WHERE status='queued' AND run_after <= now() AND kind = ANY(%s)
                        ORDER BY run_after, id FOR UPDATE SKIP LOCKED LIMIT 1)
           RETURNING *""", (WORKER_ID, kinds))


def _finish(job_id: int, status: str, error: str | None = None) -> None:
    db.execute("UPDATE jobs SET status=%s, error=%s, finished_at=now() WHERE id=%s", (status, error, job_id))


def run_one(kinds: list[str] | None = None) -> bool:
    """Claim and run a single job. Returns False when the queue had nothing ready."""
    job = claim(kinds)
    if not job:
        return False
    fn = _handlers.get(job["kind"])
    if fn is None:
        _finish(job["id"], "failed", f"no handler for {job['kind']}")
        return True
    try:
        fn(job["payload"] or {})
        _finish(job["id"], "done")
    except RetryLater as r:
        db.execute("""UPDATE jobs SET status='queued', attempts=attempts-1, locked_at=NULL, locked_by=NULL,
                      run_after=now()+make_interval(secs => %s) WHERE id=%s""", (r.seconds, job["id"]))
    except Exception as e:  # noqa: BLE001
        log.exception("job %s (%s) failed", job["id"], job["kind"])
        err = f"{type(e).__name__}: {e}\n{traceback.format_exc(limit=5)}"
        if job["attempts"] < job["max_attempts"]:
            backoff = 5 * 2 ** (job["attempts"] - 1)
            db.execute("""UPDATE jobs SET status='queued', error=%s, locked_at=NULL, locked_by=NULL,
                          run_after=now()+make_interval(secs => %s) WHERE id=%s""", (err, backoff, job["id"]))
        else:
            _finish(job["id"], "failed", err)
            on_fail = _handlers.get(job["kind"] + ":failed")
            if on_fail:
                try:
                    on_fail({**(job["payload"] or {}), "error": str(e)})
                except Exception:  # noqa: BLE001
                    log.exception("failure hook for %s failed", job["kind"])
    return True


def requeue_stale() -> int:
    return db.execute(
        """UPDATE jobs SET status='queued', locked_at=NULL, locked_by=NULL
           WHERE status='running' AND locked_at < now() - make_interval(mins => %s)""", (STALE_MINUTES,))


def _listener() -> None:
    while not _stop.is_set():
        try:
            with psycopg.connect(settings.database_url, autocommit=True) as c:
                c.execute("LISTEN jobs")
                for _ in c.notifies(timeout=30, stop_after=None):
                    _wake.set()
                    if _stop.is_set():
                        return
        except Exception:  # noqa: BLE001
            log.warning("jobs listener reconnecting", exc_info=True)
            time.sleep(2)


def _loop() -> None:
    while not _stop.is_set():
        try:
            if run_one():
                continue
        except Exception:  # noqa: BLE001
            log.exception("job loop error")
        _wake.wait(POLL_SECONDS)
        _wake.clear()


def _sweeper() -> None:
    from .agent import cards  # late import: avoid cycles
    while not _stop.wait(30):
        try:
            requeue_stale()
            cards.expire_due()
        except Exception:  # noqa: BLE001
            log.exception("sweeper error")


def start(concurrency: int | None = None) -> list[threading.Thread]:
    threads = [threading.Thread(target=_listener, name="jobs-listen", daemon=True),
               threading.Thread(target=_sweeper, name="jobs-sweep", daemon=True)]
    for i in range(concurrency or settings.worker_concurrency):
        threads.append(threading.Thread(target=_loop, name=f"jobs-{i}", daemon=True))
    for t in threads:
        t.start()
    return threads


def stop() -> None:
    _stop.set()
    _wake.set()
