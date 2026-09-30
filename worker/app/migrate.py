"""Apply db/migrations/*.sql in order. Idempotent: each file is recorded in schema_migrations,
and the SQL itself uses IF NOT EXISTS, so a half-applied file can be re-run safely.
Runs under a Postgres advisory lock so two workers starting together don't race."""
from __future__ import annotations

import glob
import logging
import os

import psycopg

from .config import settings

log = logging.getLogger(__name__)
LOCK_ID = 7_345_001


def run_migrations(database_url: str | None = None, migrations_dir: str | None = None) -> list[str]:
    url = database_url or settings.database_url
    mdir = os.path.abspath(migrations_dir or settings.migrations_dir)
    files = sorted(glob.glob(os.path.join(mdir, "*.sql")))
    applied: list[str] = []
    with psycopg.connect(url, autocommit=True) as c:
        c.execute("SELECT pg_advisory_lock(%s)", (LOCK_ID,))
        try:
            c.execute("""CREATE TABLE IF NOT EXISTS schema_migrations (
                           version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())""")
            done = {r[0] for r in c.execute("SELECT version FROM schema_migrations").fetchall()}
            for path in files:
                version = os.path.basename(path)
                if version in done:
                    continue
                sql = open(path, encoding="utf-8").read()
                with c.transaction():
                    c.execute(sql)
                    c.execute("INSERT INTO schema_migrations(version) VALUES (%s) ON CONFLICT DO NOTHING",
                              (version,))
                applied.append(version)
                log.info("applied migration %s", version)
        finally:
            c.execute("SELECT pg_advisory_unlock(%s)", (LOCK_ID,))
    return applied


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(run_migrations())
