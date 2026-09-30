"""Create the first admin from env and email them a set-password link (also printed to stdout).

    docker compose run --rm worker python -m app.seed_admin

Idempotent: if the user exists it is promoted to admin/active-or-invited and a fresh invite link is issued
(older links are invalidated). FIRST_ADMIN_PASSWORD, when set, sets the password directly (argon2id)."""
from __future__ import annotations

import hashlib
import os
import secrets
import sys

from argon2 import PasswordHasher

from . import db, jobs
from .config import settings
from .migrate import run_migrations


def main() -> int:
    email = settings.first_admin_email
    if not email:
        print("FIRST_ADMIN_EMAIL is not set", file=sys.stderr)
        return 2
    run_migrations()
    db.reset_pool()
    password = os.environ.get("FIRST_ADMIN_PASSWORD", "")
    ph = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1)  # argon2id, same params as web
    with db.conn() as c:
        user = c.execute("""INSERT INTO users(email, name, role, status) VALUES (%s,%s,'admin','invited')
                            ON CONFLICT (email) DO UPDATE SET role='admin', updated_at=now()
                            RETURNING *""", (email, settings.first_admin_name)).fetchone()
        if password:
            if len(password) < 10 or not any(ch.isdigit() for ch in password):
                print("FIRST_ADMIN_PASSWORD must be ≥10 characters and contain a number", file=sys.stderr)
                return 2
            c.execute("UPDATE users SET password_hash=%s, status='active' WHERE id=%s",
                      (ph.hash(password), user["id"]))
            c.commit()
            print(f"Admin {email} is active; sign in at {settings.app_url}/login")
            return 0
        token = secrets.token_urlsafe(32)
        c.execute("UPDATE auth_tokens SET used_at=now() WHERE user_id=%s AND kind='invite' AND used_at IS NULL",
                  (user["id"],))
        c.execute("""INSERT INTO auth_tokens(user_id, kind, token_hash, expires_at)
                     VALUES (%s,'invite',%s, now() + interval '7 days')""",
                  (user["id"], hashlib.sha256(token.encode()).hexdigest()))
        c.commit()
    url = f"{settings.app_url}/set-password?token={token}"
    print(f"Invite link for {email} (valid 7 days, single use):\n{url}")
    if settings.resend_api_key:
        jobs.enqueue("send_auth_email", {"user_id": str(user["id"]), "kind": "invite", "url": url})
        print("Invite email queued (sent by the running worker).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
