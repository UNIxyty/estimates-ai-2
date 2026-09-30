"""Postgres access: one psycopg connection pool, dict rows, pgvector registered."""
from __future__ import annotations

import json
from contextlib import contextmanager
from typing import Any, Iterator

import psycopg
from pgvector.psycopg import register_vector
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from .config import settings

_pool: ConnectionPool | None = None


def _configure(conn: psycopg.Connection) -> None:
    try:
        register_vector(conn)
    except psycopg.ProgrammingError:
        # Extension not created yet (first boot, before migrations).
        pass
    conn.commit()


def pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(
            settings.database_url, min_size=1, max_size=10, open=True,
            kwargs={"row_factory": dict_row, "autocommit": False},
            configure=_configure,
        )
    return _pool


def reset_pool() -> None:
    """Drop the pool so the next call reconnects (used after migrations create the vector type)."""
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


@contextmanager
def conn() -> Iterator[psycopg.Connection]:
    with pool().connection() as c:
        yield c


def fetchone(sql: str, params: Any = None) -> dict | None:
    with conn() as c:
        row = c.execute(sql, params).fetchone()
        c.commit()
        return row


def fetchall(sql: str, params: Any = None) -> list[dict]:
    with conn() as c:
        rows = c.execute(sql, params).fetchall()
        c.commit()
        return rows


def execute(sql: str, params: Any = None) -> int:
    with conn() as c:
        cur = c.execute(sql, params)
        c.commit()
        return cur.rowcount


def notify(channel: str, payload: str = "") -> None:
    execute("SELECT pg_notify(%s, %s)", (channel, payload))


def jsonb(value: Any) -> Jsonb:
    return Jsonb(value, dumps=lambda v: json.dumps(v, default=str))
