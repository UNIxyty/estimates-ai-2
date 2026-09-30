# Architecture and internal contracts

This is the contract between `web` (Next.js), `worker` (FastAPI) and `db` (Postgres 16 + pgvector).
Schema lives in `db/migrations/*.sql` (applied by the worker on start).

```
browser ──HTTPS (cloudflared)──► web :APP_PORT  (the only published port)
                                   │  cookie auth, ALL permission checks, DB reads/writes, job enqueue
                                   │  SSE proxy  ──► worker:8000/internal/runs/{id}/events
                                   │  viewer/edits ─► worker:8000/internal/...
                                   ▼
                                  db  ◄──── worker (job loop: SELECT … FOR UPDATE SKIP LOCKED)
                          /data/files volume mounted in web + worker
```

* `worker` is never exposed. Web calls it with header `X-Internal-Token: $INTERNAL_TOKEN`.
* The browser never talks to the worker. Every `/api/*` handler authenticates the session and
  checks the permission itself before touching the DB or calling the worker.
* The worker only acts on ids web already authorised; its agent tools add a second, independent check
  (allowed files per run).

## Storage layout (`/data/files`)

```
knowledge/<file_id>/original.<ext>      uploaded knowledge file (never modified)
knowledge/<file_id>/work.xlsx           xls converted by LibreOffice (xls only)
uploads/<upload_id>/original.<ext>      chat attachments (blanks, work lists)
documents/<document_id>/v<version>.xlsx produced estimates (each edit writes a new version)
cache/view/<sha>.json|html              viewer conversions
```

## Jobs (`jobs` table)

| kind              | payload                                   | enqueued by            |
|-------------------|-------------------------------------------|------------------------|
| `ingest_file`     | `{file_id}`  dedupe_key `ingest:<id>`      | web on upload/reanalyse |
| `run_agent`       | `{run_id}`   dedupe_key `run:<id>`         | web on new user message |
| `resume_run`      | `{run_id, card_id}` dedupe `resume:<card>` | web on card decision (run_after = now()+UNDO_SECONDS) |
| `send_email`      | `{email_send_id}`                          | worker `send_email` tool, web on Retry |
| `send_auth_email` | `{user_id, kind: invite|reset, url}`       | web on invite/resend/forgot |

Claim: `UPDATE jobs SET status='running', locked_at=now(), locked_by=$w, attempts=attempts+1
WHERE id = (SELECT id FROM jobs WHERE status='queued' AND run_after<=now() ORDER BY run_after,id
FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`. After enqueueing, web runs `NOTIFY jobs` to wake the worker.
Stale `running` jobs (locked_at older than 15 min, worker died) are requeued by the sweeper.

## Run lifecycle

`queued → running → (waiting | paused_cost) → running → done | failed | cancelled`

* **Stop**: web sets `runs.cancel_requested=true` and runs `NOTIFY run_cancel, '<run_id>'`. The worker checks between
  steps and model calls, then ends with `cancelled`.
* **Reload**: the browser reconnects to `/api/runs/{id}/events` with `Last-Event-ID` = last seq;
  the worker replays `run_events` with seq > N, then tails live (`LISTEN run_events`, payload = run_id).
  The stream closes after a terminal `run.status` event.

### Event types (`run_events.type`, SSE `event:` field, `id:` = seq)

| type               | payload |
|--------------------|---------|
| `run.status`       | `{status, error?}` |
| `step.started`     | `{step_id, label, total?}` |
| `step.progress`    | `{step_id, done, total, label?}` |
| `step.done`        | `{step_id, summary?}` |
| `step.warn`        | `{step_id, message, rows?:[{sheet,row,label}]}` |
| `text.delta`       | `{message_id, delta}` |
| `message.created`  | `{message}` (assistant message row; the text streams in afterwards) |
| `message.completed`| `{message_id, content, parts, tier, model_id, cost_usd, tokens}` |
| `card.created`     | `{card}` |
| `card.updated`     | `{card}` |
| `document.ready`   | `{document}` |
| `cost.update`      | `{run_cost_usd, conversation_cost_usd}` |

## Cards

All decisions go through `POST /api/cards/{id}/decision` and are idempotent through state guards:
`UPDATE cards SET status=$new … WHERE id=$id AND status=$expected RETURNING *`. A second click, or the same
click from another tab, matches 0 rows and returns the current card unchanged, with no second job.

* **permission** `{file_id, file_name, rows:[{sheet,row,item}], reason}`: `pending → approved|denied`,
  expires 30 min after creation (`expired`, then `ask_again` sets it back to `pending` with a new expiry). **Allow**
  appends to `runs.allowed_file_ids`, **Deny** appends to `runs.denied_file_ids` (those rows go to web search).
  Both enqueue `resume_run` delayed by `UNDO_SECONDS` (default 10). **Undo** within the window reverts the
  card to `pending` and cancels the queued job (again guarded by status + `decided_at`).
* **structure** `{template_file_id, language, sheets:[{name, sections:[…]}], columns:[…], pricing_logic:[…]}`:
  `generate` → `generating` → `done`; `change` → `changed` (agent revises and posts a new card);
  `use_reference {file_id}` → `replaced`.
* **clarify** `{questions:[{id,text,options?}]}`: `answer {answers}` → `answered`, then resume.
* **email** `{document_id, to}`: `sending → done|failed`. `retry` reuses the same `email_sends` row and
  Idempotency-Key, so a retry never sends twice.
* **cost_cap** `{run_cost_usd, cap_usd}`: `continue` raises the run cap by `RUN_COST_CAP_USD`, `stop` cancels.
* **document** / **web_prices**: informational, `ready`.

## Web API (`/api`, all JSON, session cookie `est_session`)

Auth: `POST auth/login`, `POST auth/logout`, `GET auth/me`, `GET auth/token?token=` (→ `{state: valid|expired|used|invalid, kind, email}`),
`POST auth/set-password {token,password}`, `POST auth/forgot {email}` (always 200).

Users (admin only): `GET users`, `POST users/invite {email,name,role}`, `PATCH users/{id} {role?,status?,name?}`,
`POST users/{id}/resend-invite`, `DELETE users/{id}` (disables, kills sessions). An admin cannot demote or disable the last active admin.

Profile: `GET|PATCH profile {name, send_estimates_to}`, `POST profile/password {current,next}`.

Knowledge: `GET files`, `POST files` (multipart: `file`, `tag`), `GET files/{id}`, `PATCH files/{id} {tag}`,
`GET files/{id}/forget-preview`, `DELETE files/{id}`, `POST files/{id}/reanalyse`, `GET files/{id}/download`,
`GET files/{id}/items?offset&limit&q`, `PATCH files/{id}/items/{itemId}`, `PATCH files/{id}/logic/{logicId}`,
`POST files/{id}/notes`, `PATCH|DELETE files/{id}/notes/{noteId}`, `GET files/{id}/usage`, `GET knowledge/status`.

Chat: `GET conversations?q=`, `POST conversations`, `GET conversations/{id}`, `PATCH conversations/{id} {title}`,
`DELETE conversations/{id}`, `POST conversations/{id}/messages {text, attachment_ids[], reference_ids[]}`
(checks: owner, chat unlocked, budget, no active run) → `{message, run}`, `POST uploads` (multipart),
`GET runs/{id}/events` (SSE), `POST runs/{id}/stop`, `GET picker` ("/" picker, grouped by tag),
`POST cards/{id}/decision {action, data?}` with action one of `allow|deny|undo|ask_again|generate|change|use_reference|answer|retry|continue|stop`.

Documents/viewer: `GET documents/{id}`, `GET documents/{id}/download`, `GET documents/{id}/sheets`,
`GET documents/{id}/rows?sheet&offset&limit&filter`, `GET documents/{id}/rows/{sheet}/{row}` (provenance),
`PATCH documents/{id}/rows/{sheet}/{row} {qty?,unit_labour?,unit_material?,norm_h_per_unit?}`.
The same viewer endpoints exist for knowledge files under `files/{id}/view/…` (`sheets`, `rows`, `html` for docx,
`raw` for pdf.js).

Settings: `GET usage?days=30`, `GET|PUT settings/routing` (PUT admin), `GET|PUT settings/budget` (PUT admin),
`GET budget/status`, `GET composer-hint`. Health: `GET health` → `{ok, build, db, worker}`.

## Worker internal HTTP (`X-Internal-Token` required, except `/health`)

`GET /health` · `GET /internal/runs/{run_id}/events?after=N` (SSE) ·
`GET /internal/view/sheets?kind=file|document&id=` · `GET /internal/view/rows?kind&id&sheet&offset&limit&filter` ·
`GET /internal/view/html?kind=file&id=` (docx → HTML via mammoth) ·
`POST /internal/documents/{id}/rows/{sheet}/{row}` (recalculate + write workbook; web has checked ownership) ·
`POST /internal/files/{id}/recompute` (after a user override).

## Pricing a row (worker/app/agent/pricing.py)

1. exact / normalised match in allowed files (unit normalisation + attribute equality)
2. semantic (pgvector cosine) with hard attribute filters (cores, cross-section, IP, modules, gangs, category)
3. norm lookup: parameterised > item > category
4. batched model decision for rows still ambiguous (one call per ≤40 rows)
5. web search only where no allowed file has a price (after Deny, or nothing anywhere)
6. otherwise `NO PRICE` + a `step.warn` event

If the best match sits in a file outside the run's allowed set, the tool returns `found in unselected file X`,
and the agent posts a permission card for those rows.

## Tiers and tasks

`fast | standard | advanced`. Tasks: `simple_question, short_reply, email` → fast;
`file_analysis, fill_blank, web_search` → standard; `generate, complex_reasoning` → advanced;
`classify` → fast (router call). Stored in `settings.routing`.
