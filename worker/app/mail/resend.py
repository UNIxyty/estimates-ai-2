"""Email through Resend: invites, password resets and estimates.

Estimate emails go ONLY to the requesting user's Profile "Send estimates to" address (or their login
email when unset); the recipient is resolved here from the DB, never taken from model output.
Retries reuse the same email_sends row and Resend Idempotency-Key, so a retry cannot send twice."""
from __future__ import annotations

import base64
import logging
import os

import httpx

from .. import db, jobs
from ..agent import cards
from ..config import settings

log = logging.getLogger(__name__)
RESEND_URL = "https://api.resend.com/emails"


class EmailError(RuntimeError):
    pass


def send(*, to: str, subject: str, html: str, text: str, idempotency_key: str | None = None,
         attachments: list[dict] | None = None) -> str:
    if not settings.resend_api_key:
        raise EmailError("RESEND_API_KEY is not set")
    headers = {"Authorization": f"Bearer {settings.resend_api_key}"}
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key[:256]
    body = {"from": settings.email_from, "to": [to], "subject": subject, "html": html, "text": text}
    if attachments:
        body["attachments"] = attachments
    r = httpx.post(RESEND_URL, json=body, headers=headers, timeout=30)
    if r.status_code >= 400:
        raise EmailError(f"Resend {r.status_code}: {r.text[:300]}")
    return r.json().get("id", "")


def _layout(title: str, body_html: str) -> str:
    return (f"<div style=\"font-family:'IBM Plex Sans',Arial,sans-serif;font-size:14px;line-height:1.5\">"
            f"<h2 style=\"font-size:18px\">{title}</h2>{body_html}</div>")


@jobs.handler("send_auth_email")
def send_auth_email(payload: dict) -> None:
    user = db.fetchone("SELECT email, name FROM users WHERE id=%s", (payload["user_id"],))
    if not user:
        return
    url = payload["url"]
    if payload.get("kind") == "reset":
        subject, title = "Reset your password", "Reset your password"
        lead = "Use this link to choose a new password. It expires in 1 hour and works once."
    else:
        subject, title = "You're invited to Estimates", "You're invited"
        lead = "Use this link to set your password and sign in. It expires in 7 days and works once."
    html = _layout(title, f"<p>{lead}</p><p><a href=\"{url}\">{url}</a></p>")
    send(to=user["email"], subject=subject, html=html, text=f"{lead}\n\n{url}\n")
    # Don't keep live links lying around in the jobs table.
    db.execute("UPDATE jobs SET payload = payload - 'url' WHERE kind='send_auth_email' AND payload->>'url'=%s",
               (url,))


@jobs.handler("send_email")
def send_estimate_email(payload: dict) -> None:
    es = db.fetchone("""SELECT e.*, d.name AS doc_name, d.stored_path, d.totals, d.currency
                        FROM email_sends e JOIN documents d ON d.id = e.document_id WHERE e.id=%s""",
                     (payload["email_send_id"],))
    if not es or es["status"] == "done":
        return  # already sent: idempotent no-op
    db.execute("UPDATE email_sends SET status='sending', attempts=attempts+1, updated_at=now() WHERE id=%s",
               (es["id"],))
    try:
        with open(es["stored_path"], "rb") as fh:
            content = base64.b64encode(fh.read()).decode()
        totals = es["totals"] or {}
        total = totals.get("total")
        summary = (f"<p>Attached: <b>{es['doc_name']}</b>.</p>"
                   + (f"<p>Total: {total:,.2f} {es['currency']}</p>" if isinstance(total, (int, float)) else ""))
        pid = send(to=es["to_email"], subject=f"Estimate: {es['doc_name']}", html=_layout("Your estimate", summary),
                   text=f"Attached: {es['doc_name']}", idempotency_key=es["idempotency_key"],
                   attachments=[{"filename": os.path.basename(es["doc_name"]) if es["doc_name"].endswith(".xlsx")
                                 else es["doc_name"] + ".xlsx", "content": content}])
    except Exception as e:  # noqa: BLE001
        db.execute("UPDATE email_sends SET status='failed', error=%s, updated_at=now() WHERE id=%s",
                   (str(e)[:500], es["id"]))
        if es["card_id"]:
            card = cards.get(str(es["card_id"]))
            cards.update(str(es["card_id"]), status="failed",
                         payload={**(card["payload"] if card else {}), "error": str(e)[:300]})
        log.warning("estimate email failed: %s", e)
        return  # failure is surfaced on the card (Retry), not retried silently
    db.execute("UPDATE email_sends SET status='done', provider_id=%s, error=NULL, updated_at=now() WHERE id=%s",
               (pid, es["id"]))
    if es["card_id"]:
        cards.update(str(es["card_id"]), status="done")
