#!/usr/bin/env python3
"""Full-stack smoke test over HTTP against a running web (and worker behind it).

    WEB=http://127.0.0.1:3100 ADMIN_EMAIL=... ADMIN_PASSWORD=... python scripts/e2e_smoke.py REF.xlsx BLANK.xlsx [OTHER_REF.xlsx]

Flow: login → upload reference(s) (select only the first) → wait Analysed → chat unlocked → upload blank →
send message → follow SSE to the end → allow permission card (if any) → follow resume → open the document
in the viewer → download the real xlsx → usage page → health. Exits non-zero on the first failure."""
from __future__ import annotations

import json
import os
import sys
import time

import httpx

WEB = os.environ.get("WEB", "http://127.0.0.1:3100")


def check(cond, msg):
    if not cond:
        print(f"FAIL: {msg}")
        sys.exit(1)
    print(f"ok   {msg}")


def sse(c: httpx.Client, run_id: str, after: int = 0, timeout: float = 120) -> tuple[list[tuple[int, str, dict]], int]:
    events = []
    with c.stream("GET", f"/api/runs/{run_id}/events", headers={"Last-Event-ID": str(after)}, timeout=timeout) as r:
        check(r.status_code == 200, f"SSE opened for run {run_id[:8]} (after {after})")
        cur: dict = {}
        for line in r.iter_lines():
            if line.startswith("id: "):
                cur["id"] = int(line[4:])
            elif line.startswith("event: "):
                cur["event"] = line[7:]
            elif line.startswith("data: "):
                cur["data"] = json.loads(line[6:])
            elif line == "" and cur:
                if cur.get("event") == "end":
                    break
                if "id" in cur:
                    events.append((cur["id"], cur["event"], cur.get("data", {})))
                    after = cur["id"]
                    if cur["event"] == "run.status" and cur["data"].get("status") in ("done", "failed", "cancelled", "waiting"):
                        if cur["data"]["status"] == "waiting":
                            break
                cur = {}
    return events, after


def main() -> int:
    ref, blank = sys.argv[1], sys.argv[2]
    other = sys.argv[3] if len(sys.argv) > 3 else None
    c = httpx.Client(base_url=WEB, timeout=60)
    h = c.get("/api/health").json()
    check(h.get("ok") and h.get("build"), f"health ok, build {h.get('build')}, worker {str(h.get('worker'))[:60]}")
    check(c.get("/api/auth/me").status_code == 401, "unauthenticated /api/auth/me → 401")
    r = c.post("/api/auth/login", json={"email": os.environ["ADMIN_EMAIL"], "password": os.environ["ADMIN_PASSWORD"]})
    check(r.status_code == 200 and "est_session" in r.headers.get("set-cookie", ""), "login sets httpOnly cookie")
    check("HttpOnly" in r.headers["set-cookie"], "cookie is HttpOnly")

    file_ids = []
    for path, tag in [(ref, "reference_estimate")] + ([(other, "reference_estimate")] if other else []):
        with open(path, "rb") as fh:
            r = c.post("/api/files", files={"file": (os.path.basename(path), fh)}, data={"tag": tag})
        check(r.status_code in (200, 201), f"uploaded {os.path.basename(path)} → {r.status_code}")
        file_ids.append(r.json().get("file", r.json()).get("id"))
    seen = set()
    for _ in range(120):
        files = c.get("/api/files").json()
        files = files.get("files", files)
        st = {f["id"]: f["status"] for f in files if f["id"] in file_ids}
        seen |= set(st.values())
        if all(s in ("analysed", "failed") for s in st.values()) and len(st) == len(file_ids):
            break
        time.sleep(1)
    check(all(s == "analysed" for s in st.values()), f"files analysed (statuses seen: {sorted(seen)})")
    detail = c.get(f"/api/files/{file_ids[0]}").json()
    check(detail, "file detail loads")
    check(c.get("/api/knowledge/status").json().get("chatUnlocked") is True, "chat unlocked")

    conv = c.post("/api/conversations", json={}).json()
    conv = conv.get("conversation", conv)
    with open(blank, "rb") as fh:
        up = c.post("/api/uploads", files={"file": (os.path.basename(blank), fh)}, data={"conversation_id": conv["id"]}).json()
    up = up.get("upload", up)
    r = c.post(f"/api/conversations/{conv['id']}/messages",
               json={"text": "Aizpildi šo tāmi", "attachment_ids": [up["id"]], "reference_ids": [file_ids[0]]})
    check(r.status_code in (200, 201), f"message accepted → {r.status_code} {r.text[:120]}")
    run = r.json()["run"]
    events, last = sse(c, run["id"])
    types = [e[1] for e in events]
    check("step.started" in types and "step.progress" in types, f"live steps streamed ({len(events)} events)")
    check("document.ready" in types, "document.ready event")
    status = [e[2]["status"] for e in events if e[1] == "run.status"][-1]
    check(status in ("done", "waiting"), f"run finished with status {status}")

    # reload re-attach: replay from the start gives the same events
    replay, _ = sse(c, run["id"], after=0)
    check([e[0] for e in replay][:len(events)] == [e[0] for e in events], "reload replays persisted events")

    convo = c.get(f"/api/conversations/{conv['id']}").json()
    cards = convo.get("cards", [])
    perm = [k for k in cards if k["kind"] == "permission" and k["status"] == "pending"]
    if perm:
        card = perm[0]
        a = c.post(f"/api/cards/{card['id']}/decision", json={"action": "allow"})
        b = c.post(f"/api/cards/{card['id']}/decision", json={"action": "allow"})
        check(a.status_code == 200 and b.status_code == 200 and b.json()["card"]["status"] == "approved",
              "allow is idempotent (double click)")
        events2, last = sse(c, run["id"], after=last, timeout=180)
        check(any(e[1] == "document.ready" for e in events2), "resume after Allow updated the document")
    docs = c.get(f"/api/conversations/{conv['id']}").json().get("documents", [])
    check(docs, "conversation lists the document")
    doc = docs[-1]
    sheets = c.get(f"/api/documents/{doc['id']}/sheets").json()
    check(sheets.get("sheets"), f"viewer sheets: {[s['name'] for s in sheets['sheets']]}")
    rows = c.get(f"/api/documents/{doc['id']}/rows", params={"sheet": 0, "limit": 50}).json()
    check(rows.get("rows"), f"viewer rows page: {rows.get('total')} rows")
    dl = c.get(f"/api/documents/{doc['id']}/download")
    check(dl.status_code == 200 and dl.content[:2] == b"PK", f"download returns the real xlsx ({len(dl.content)} bytes)")
    usage = c.get("/api/usage", params={"days": 30})
    check(usage.status_code == 200, "usage page data")
    check(c.get("/api/composer-hint").status_code == 200, "composer hint")
    check(c.get("/api/budget/status").status_code == 200, "budget status")
    print("\nALL OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
