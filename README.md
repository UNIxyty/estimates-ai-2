# Estimates AI Agent

Invite-only estimating assistant for electrical contractors. It learns from your own reference estimates,
hourly-norm files and price lists, then **fills blanks** or **generates estimates from a work list**. It works
deterministically wherever code can decide, and uses AWS Bedrock models only where it can't.

```
browser ─► cloudflared ─► web (Next.js 15, :APP_PORT — the only published port)
                            │  auth, every permission check, API, SSE proxy
                            ├─► worker (FastAPI, internal :8000)  parsing · analysis · agent runs · xlsx · email
                            └─► db (Postgres 16 + pgvector, internal)  data + job queue (SKIP LOCKED)
                            /data/files volume shared by web + worker
```

Contracts (schema, jobs, run events, cards, API routes): [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

> **UI status.** The Claude Design project could not be imported in the build session: `/design-login` can't
> run headless, and the files weren't in the workspace. The web app has every route and API, but its pages are
> **unstyled functional shells** marked "design import pending". See [Design import](#design-import) to finish it.

## Deploy (Docker Compose, one published port)

```bash
cp .env.example .env            # fill in secrets, Bedrock, Resend, search key, APP_PORT, APP_URL
./scripts/check-env.sh          # warns if exported shell vars would shadow .env (see gotchas)
export BUILD_HASH=$(git rev-parse --short HEAD)
docker compose build --no-cache web && docker compose build worker
docker compose up -d
docker compose run --rm worker python -m app.seed_admin    # first admin: prints/emails a set-password link
docker compose run --rm worker python -m app.bedrock_models # checks the model IDs exist in your region
curl -s http://127.0.0.1:$APP_PORT/api/health               # {"ok":true,"build":"<hash>","db":"ok","worker":{…}}
```

Point your existing cloudflared tunnel at `http://127.0.0.1:<APP_PORT>`. Only `web` publishes a port, bound to
`127.0.0.1` by default (`APP_BIND`). `db` and `worker` are reachable only on the compose network. To run the
tunnel inside compose instead, set `TUNNEL_TOKEN` and run `docker compose --profile tunnel up -d`.

Migrations (`db/migrations/*.sql`) are idempotent and additive. The worker applies them on every start under an
advisory lock.

### Known gotchas on this server

1. **An exported `DATABASE_URL` in your shell shadows `.env` during compose interpolation.** This app never reads
   `DATABASE_URL`: the connection string is `ESTIMATES_DATABASE_URL` and it reaches the containers through
   `env_file`, which the shell can't override. Only `APP_PORT`, `APP_BIND`, `BUILD_HASH` and
   `WORKER_MEM_LIMIT` are interpolated. **Run `./scripts/check-env.sh`:** it warns loudly about any exported
   variable that would shadow them, and about a stray `DATABASE_URL`.
2. **Frontend rebuilds can serve a stale cached bundle.** Always rebuild web with
   `BUILD_HASH=$(git rev-parse --short HEAD) docker compose build --no-cache web`, then
   `docker compose up -d web`. The build hash is printed in the page footer and in `/api/health` (web and worker)
   so you can confirm which bundle is live.
3. The worker needs RAM for big workbooks: see [Resources](#resources).

## What it does

* **Auth**: invite-only (no sign-up), roles `estimator`/`admin`, argon2id, httpOnly session cookies,
  single-use invite (7 days) / reset (1 hour) links with an expired state, emails via Resend. Every permission
  check is in the API layer.
* **Knowledge base**: `.xlsx .xls .docx .pdf`, tagged `reference_estimate | hourly_norms | price_list | other`.
  Pipeline: `Queued → Reading → Analysing (%) → Analysed | Failed(reason)`. Deterministic parsing, structure
  detection (headers and position, unit block vs row-total block), per-sheet/section hourly rates, calculation
  logic sentences, priced-row extraction, parameterised norms and embeddings. The model is used only for
  ambiguous columns, logic summaries and notes, and the number of cells/rows that needed it is logged. User overrides
  always win over re-analysis. Chat is locked (in the API) until one reference estimate is analysed.
* **Agent**: every message is a run in the worker, streamed to the browser over SSE (proxied by web). It
  re-attaches after a reload and can be stopped.
  Pricing per row, cheapest first: exact/normalised → semantic (pgvector + hard attribute filters) → norms
  (parameterised > item > category) → **one batched model call per ≤40 ambiguous rows** → web search (only
  where no allowed file has a price) → `NO PRICE`. Every row stores its provenance (matched rows, norm,
  source, confidence, reason).
* **Permission rule** (backend, not prompt): tools read only the run's allowed files. A best match in an
  unselected file parks those rows behind a permission card (Allow / Deny, 30-min expiry, Ask again, Undo, and
  idempotent across double clicks and tabs). Denied rows go to web search.
* **Output**: values are written into a copy of the blank, touching only value cells (formulas, styles, merges and
  widths are kept), with the `Kilde`/source column in the blank's language. Generated estimates are built from
  the template's own structure and formatting.
* **Routing/costs**: Fast / Standard / Advanced tiers mapped to Bedrock model IDs. Routing is rules-first with a
  Fast classifier for free text, and there's an escalate-when-unsure toggle. A disabled tier sends its tasks up a
  tier, and per-task overrides are supported. Every model, embedding and search call goes to the `usage` ledger
  with the real token counts × an editable price table. There's a monthly budget with alert and over-budget
  actions, enforced before each run, and a **per-run safety cap** (`RUN_COST_CAP_USD`) that pauses and asks.

## Resources

Measured in the build sandbox (deterministic path, no model calls):

| Workload | Time | Peak RSS (worker process) |
|---|---|---|
| Parse + analyse a 5,000-row × 15-col workbook | ≈2.3 s | 58 MB |
| Parse + analyse a 20,000-row × 15-col workbook | ≈9.2 s | 129 MB |
| Ingest a 5,000-row reference **and** fill a 5,000-row blank in one process | 2.4 s + 9.9 s | 146 MB |
| DocViewer: first conversion of a 5,000-row sheet / page of 200 rows | ≈2.2 s / ≈6 ms | — |

`.xls` conversion (LibreOffice headless) adds roughly 200–300 MB per conversion while it runs. I couldn't measure
that here because the sandbox blocks the Debian mirror. With `WORKER_CONCURRENCY=3`, give the worker **at least
1 GB**. The compose default is `WORKER_MEM_LIMIT=2g`, which leaves headroom for large `.xls` files.

## Tests

```bash
# worker (needs a Postgres 16 + pgvector; tests default to postgresql://estimates:dev@127.0.0.1:5433/estimates)
docker run -d --name est-db -e POSTGRES_USER=estimates -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=estimates \
  -p 5433:5432 pgvector/pgvector:pg16
cd worker && uv venv -p 3.12 .venv && uv pip install -p .venv/bin/python -e '.[dev]'
ALLOW_NO_INTERNAL_TOKEN=1 .venv/bin/pytest -q
# web
cd web && npm ci && npm test && npm run build
```

## Accuracy gate

```bash
docker compose run --rm -v /path/to/estimates:/gate worker \
  python -m app.accuracy_gate --loo /gate/references --norms /gate/norms/*.xlsx --out /gate/report.md
```
Leave-one-out: each reference estimate in turn becomes the held-out file. The rest are ingested, the held-out
file's price cells are blanked, the agent fills the blank, and the result is compared row by row with the hand-priced
values (labour and material separately, ±15%). The report also shows cost per run and the share of rows priced
without a model call.

## Design import

To finish the UI, either use Claude Design's **Send to Claude Code Web** (it seeds the project into the
workspace) or run `/design-login` once in an interactive Claude Code session on your machine, then ask for the
UI pass. The pages under `web/src/app` already call the final API, so the port is a visual layer: tokens go in
`web/src/styles/tokens.css`, with components as named in the design (Sidebar, SettingsNav, Composer, Message,
InlineCard, DocViewer).
