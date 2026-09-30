-- 0001_init: core schema. Idempotent and additive: every statement uses
-- IF NOT EXISTS / OR REPLACE so re-running is harmless. Applied by the worker
-- on start (worker/app/migrate.py) under a Postgres advisory lock.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------- users/auth

CREATE TABLE IF NOT EXISTS users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             citext NOT NULL UNIQUE,
  name              text NOT NULL DEFAULT '',
  role              text NOT NULL DEFAULT 'estimator' CHECK (role IN ('estimator','admin')),
  status            text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','disabled')),
  password_hash     text,                         -- argon2id PHC string
  send_estimates_to citext,                       -- Profile "Send estimates to"; defaults to email
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_active_at    timestamptz
);

-- Session id = sha256(hex) of the random cookie token; the raw token never hits the DB.
CREATE TABLE IF NOT EXISTS sessions (
  id          text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  user_agent  text,
  ip          text
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

-- Invite (7 days) and reset (1 hour) links. Single use: used_at set atomically.
CREATE TABLE IF NOT EXISTS auth_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('invite','reset')),
  token_hash  text NOT NULL UNIQUE,              -- sha256 hex of raw token
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_tokens_user_idx ON auth_tokens(user_id, kind);

-- ---------------------------------------------------------------- settings

-- Keys: 'routing' (tiers, task map, overrides, escalate toggle),
--       'prices'  (per-model $/1M tokens + web search unit cost),
--       'budget'  (monthly amount, alert pct, over-budget action).
CREATE TABLE IF NOT EXISTS settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- jobs

CREATE TABLE IF NOT EXISTS jobs (
  id            bigserial PRIMARY KEY,
  kind          text NOT NULL,                  -- ingest_file | run_agent | resume_run | send_email | send_auth_email | sweep
  payload       jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','cancelled')),
  attempts      int NOT NULL DEFAULT 0,
  max_attempts  int NOT NULL DEFAULT 3,
  run_after     timestamptz NOT NULL DEFAULT now(),
  dedupe_key    text,                           -- optional: at most one queued/running job per key
  locked_at     timestamptz,
  locked_by     text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs(run_after, id) WHERE status = 'queued';
CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedupe_idx ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','running');

-- ---------------------------------------------------------------- knowledge base

-- Knowledge is shared across the workspace (single tenant); uploaded_by is recorded.
CREATE TABLE IF NOT EXISTS files (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uploaded_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  original_name   text NOT NULL,
  ext             text NOT NULL CHECK (ext IN ('xlsx','xls','docx','pdf')),
  mime            text,
  size_bytes      bigint NOT NULL DEFAULT 0,
  sha256          text,
  stored_path     text NOT NULL,                -- original bytes, under /data/files
  work_path       text,                         -- xls -> xlsx conversion (original kept)
  tag             text NOT NULL DEFAULT 'other' CHECK (tag IN ('reference_estimate','hourly_norms','price_list','other')),
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','reading','analysing','analysed','failed')),
  progress        int NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  fail_reason     text,
  language        text,                         -- LV / EN / DA / ...
  summary         jsonb NOT NULL DEFAULT '{}',  -- short description, sheet list, currency, counts
  stats           jsonb NOT NULL DEFAULT '{}',  -- rows parsed, model_cells, model_rows, timings
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  analysed_at     timestamptz,
  deleted_at      timestamptz
);
CREATE INDEX IF NOT EXISTS files_status_idx ON files(status) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS file_sheets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id       uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  idx           int NOT NULL,
  name          text NOT NULL,
  kind          text NOT NULL DEFAULT 'estimate',  -- estimate | norms | prices | summary | other
  is_electrical boolean,
  row_count     int NOT NULL DEFAULT 0,
  col_count     int NOT NULL DEFAULT 0,
  header_row    int,                                -- 1-based
  first_data_row int,
  -- columns: [{col:"C", idx:3, header:"Daudz.", meaning:"qty", source:"header|position|model", confidence:0.9}]
  columns       jsonb NOT NULL DEFAULT '[]',
  unit_block    jsonb,                              -- {norm_h:"F", labour:"G", material:"H", ...}
  total_block   jsonb,                              -- {labour:"J", material:"K", total:"L", ...}
  hourly_rates  jsonb NOT NULL DEFAULT '[]',        -- [{rate:12.5, currency:"EUR", rows:[a,b], source:"cell F3"}]
  currency      text,
  language      text,
  UNIQUE (file_id, idx)
);

CREATE TABLE IF NOT EXISTS file_sections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id     uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  sheet_id    uuid REFERENCES file_sheets(id) ON DELETE CASCADE,
  ord         int NOT NULL DEFAULT 0,
  title       text NOT NULL,
  row_start   int NOT NULL,
  row_end     int NOT NULL,
  subtotal_row int,
  hourly_rate numeric(12,4),
  kind        text NOT NULL DEFAULT 'section'
);
CREATE INDEX IF NOT EXISTS file_sections_file_idx ON file_sections(file_id);

-- Calculation logic sentences. User override always wins over re-analysis.
CREATE TABLE IF NOT EXISTS file_logic (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id           uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  sheet_name        text,
  section_title     text,
  ord               int NOT NULL DEFAULT 0,
  kind              text NOT NULL CHECK (kind IN ('labour','material','subtotal','markup','rate','other')),
  logic_key         text NOT NULL,              -- stable key so overrides survive re-analysis
  sentence          text NOT NULL,
  numbers           jsonb NOT NULL DEFAULT '{}',
  source            text NOT NULL DEFAULT 'code' CHECK (source IN ('code','model')),
  override_sentence text,
  override_numbers  jsonb,
  overridden_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  overridden_at     timestamptz,
  UNIQUE (file_id, logic_key)
);

-- Every priced row of a reference estimate / price list.
CREATE TABLE IF NOT EXISTS price_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id         uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  sheet_name      text NOT NULL,
  row_idx         int NOT NULL,                 -- 1-based sheet row
  section_title   text,
  item_text       text NOT NULL,
  item_norm       text NOT NULL,                -- normalised text for exact matching
  unit            text,
  unit_norm       text,                         -- canonical unit: m | pcs | m2 | m3 | kg | set | h | km | l | t | ...
  qty             numeric(18,4),
  norm_h_per_unit numeric(18,6),
  unit_labour     numeric(18,4),
  unit_material   numeric(18,4),
  total_labour    numeric(18,4),
  total_material  numeric(18,4),
  hourly_rate     numeric(12,4),
  currency        text NOT NULL DEFAULT 'EUR',
  attrs           jsonb NOT NULL DEFAULT '{}',  -- {cores:3, cross_section_mm2:1.5, ip:44, modules:36, gangs:2, category:"cable"}
  category        text,
  source_cells    jsonb NOT NULL DEFAULT '{}',  -- {"qty":"D12","unit_labour":"G12",...}
  extracted_by    text NOT NULL DEFAULT 'code' CHECK (extracted_by IN ('code','model')),
  override        jsonb,                        -- user edits: fields that win over analysis
  overridden_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  overridden_at   timestamptz,
  embedding       vector(1024),
  UNIQUE (file_id, sheet_name, row_idx)
);
CREATE INDEX IF NOT EXISTS price_items_norm_idx ON price_items(item_norm);
CREATE INDEX IF NOT EXISTS price_items_file_idx ON price_items(file_id);
CREATE INDEX IF NOT EXISTS price_items_cat_idx ON price_items(category, unit_norm);
CREATE INDEX IF NOT EXISTS price_items_emb_idx ON price_items USING hnsw (embedding vector_cosine_ops);

-- Hourly norms from norm files at whatever specificity they give.
CREATE TABLE IF NOT EXISTS norms (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id       uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  sheet_name    text,
  row_idx       int,
  category      text,
  item_text     text NOT NULL,
  item_norm     text NOT NULL,
  unit          text,
  unit_norm     text,
  hours         numeric(18,6) NOT NULL,         -- hours per unit
  specificity   text NOT NULL CHECK (specificity IN ('parameterised','item','category')),
  params        jsonb NOT NULL DEFAULT '{}',    -- {"modules": 36}
  attrs         jsonb NOT NULL DEFAULT '{}',
  extracted_by  text NOT NULL DEFAULT 'code' CHECK (extracted_by IN ('code','model')),
  override      jsonb,
  overridden_by uuid REFERENCES users(id) ON DELETE SET NULL,
  overridden_at timestamptz,
  embedding     vector(1024)
);
CREATE INDEX IF NOT EXISTS norms_file_idx ON norms(file_id);
CREATE INDEX IF NOT EXISTS norms_cat_idx ON norms(category, unit_norm);
CREATE INDEX IF NOT EXISTS norms_emb_idx ON norms USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS agent_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id     uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  ord         int NOT NULL DEFAULT 0,
  text        text NOT NULL,
  source      text NOT NULL CHECK (source IN ('model','user')),   -- 'user' renders as "Your note"
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  edited      boolean NOT NULL DEFAULT false                       -- model note edited by user -> "Edited"
);
CREATE INDEX IF NOT EXISTS agent_notes_file_idx ON agent_notes(file_id);

-- ---------------------------------------------------------------- chat

CREATE TABLE IF NOT EXISTS conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text NOT NULL DEFAULT 'New estimate',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations(user_id, updated_at DESC);

-- Chat attachments (blanks, work lists). Not part of the knowledge base.
CREATE TABLE IF NOT EXISTS uploads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  original_name text NOT NULL,
  ext           text NOT NULL,
  mime          text,
  size_bytes    bigint NOT NULL DEFAULT 0,
  stored_path   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              text NOT NULL DEFAULT 'chat',   -- chat | fill_blank | generate | qa | email (refined by the worker)
  status            text NOT NULL DEFAULT 'queued' CHECK (status IN
                      ('queued','running','waiting','paused_cost','done','failed','cancelled')),
  -- waiting: blocked on a card (structure / clarify / permission) with nothing else to do
  selected_file_ids uuid[] NOT NULL DEFAULT '{}',   -- "/" picker selection; empty = all analysed
  allowed_file_ids  uuid[] NOT NULL DEFAULT '{}',   -- resolved allowed set (grows on Allow)
  denied_file_ids   uuid[] NOT NULL DEFAULT '{}',
  attachment_ids    uuid[] NOT NULL DEFAULT '{}',
  tier_override     text,                           -- forced tier (e.g. budget "fast only")
  cost_usd          numeric(12,6) NOT NULL DEFAULT 0,
  cost_cap_usd      numeric(12,4) NOT NULL,
  state             jsonb NOT NULL DEFAULT '{}',    -- resumable agent state
  cancel_requested  boolean NOT NULL DEFAULT false,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz
);
CREATE INDEX IF NOT EXISTS runs_conv_idx ON runs(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  run_id          uuid REFERENCES runs(id) ON DELETE SET NULL,
  role            text NOT NULL CHECK (role IN ('user','assistant')),
  content         text NOT NULL DEFAULT '',
  -- structured parts: [{type:"text",text}, {type:"chip",kind:"row",document_id,sheet,row,label},
  --                    {type:"chip",kind:"file",file_id,label}, {type:"card",card_id}, {type:"steps",...}]
  parts           jsonb NOT NULL DEFAULT '[]',
  attachment_ids  uuid[] NOT NULL DEFAULT '{}',
  reference_ids   uuid[] NOT NULL DEFAULT '{}',
  tier            text,
  model_id        text,
  cost_usd        numeric(12,6),
  tokens          jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages(conversation_id, created_at);

-- Persisted run events: SSE replays these on reload, then tails live ones.
CREATE TABLE IF NOT EXISTS run_events (
  id          bigserial PRIMARY KEY,
  run_id      uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq         int NOT NULL,
  type        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);

CREATE TABLE IF NOT EXISTS cards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      uuid REFERENCES messages(id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN
                    ('permission','structure','clarify','document','email','web_prices','cost_cap')),
  status          text NOT NULL DEFAULT 'pending',
  -- permission: pending|approved|denied|expired      structure: pending|generating|changed|replaced|done
  -- clarify: pending|answered                         email: sending|done|failed
  -- cost_cap: pending|continued|stopped               document / web_prices: ready
  payload         jsonb NOT NULL DEFAULT '{}',
  decision        jsonb,
  decided_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at      timestamptz,
  expires_at      timestamptz,
  version         int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cards_run_idx ON cards(run_id);
CREATE INDEX IF NOT EXISTS cards_conv_idx ON cards(conversation_id);

-- Estimates produced by runs.
CREATE TABLE IF NOT EXISTS documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid REFERENCES runs(id) ON DELETE SET NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  stored_path     text NOT NULL,
  source_upload_id uuid REFERENCES uploads(id) ON DELETE SET NULL,  -- the blank
  template_file_id uuid REFERENCES files(id) ON DELETE SET NULL,    -- reference used as template
  mode            text NOT NULL CHECK (mode IN ('fill','generate')),
  language        text,
  currency        text NOT NULL DEFAULT 'EUR',
  totals          jsonb NOT NULL DEFAULT '{}',  -- {labour, material, total, rows, priced, web, check, no_price, edited}
  version         int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Per-row provenance: powers the DocViewer inspector and follow-up Q&A.
CREATE TABLE IF NOT EXISTS estimate_rows (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  sheet_name      text NOT NULL,
  row_idx         int NOT NULL,
  section_title   text,
  item_text       text NOT NULL,
  unit            text,
  unit_norm       text,
  qty             numeric(18,4),
  norm_h_per_unit numeric(18,6),
  hourly_rate     numeric(12,4),
  unit_labour     numeric(18,4),
  unit_material   numeric(18,4),
  total_labour    numeric(18,4),
  total_material  numeric(18,4),
  price_source    text NOT NULL CHECK (price_source IN
                    ('exact','semantic','norm','model','web','none','pending_permission','edited')),
  confidence      text CHECK (confidence IN ('high','medium','low')),
  confidence_pct  int,
  reason          text,
  matched         jsonb NOT NULL DEFAULT '[]',  -- [{price_item_id,file_id,file_name,sheet,row,item_text,similarity}]
  norm_ref        jsonb,                        -- {norm_id,file_id,file_name,hours,specificity}
  web             jsonb,                        -- {product,unit_price,currency,url,fetched_at}
  flags           text[] NOT NULL DEFAULT '{}', -- WEB | CHECK | NO PRICE | EDITED
  original        jsonb,                        -- values before a user edit
  edited_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  edited_at       timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, sheet_name, row_idx)
);

CREATE TABLE IF NOT EXISTS web_prices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid REFERENCES runs(id) ON DELETE CASCADE,
  document_id   uuid REFERENCES documents(id) ON DELETE CASCADE,
  sheet_name    text,
  row_idx       int,
  query         text NOT NULL,
  product       text,
  unit_price    numeric(18,4),
  currency      text,
  url           text,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  qty           numeric(18,4),
  total         numeric(18,4)
);

-- "Used in" on the file detail page.
CREATE TABLE IF NOT EXISTS file_usage (
  id              bigserial PRIMARY KEY,
  file_id         uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  run_id          uuid REFERENCES runs(id) ON DELETE CASCADE,
  document_id     uuid REFERENCES documents(id) ON DELETE SET NULL,
  rows_used       int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id, run_id)
);

CREATE TABLE IF NOT EXISTS email_sends (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id         uuid REFERENCES cards(id) ON DELETE SET NULL,
  run_id          uuid REFERENCES runs(id) ON DELETE SET NULL,
  document_id     uuid REFERENCES documents(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_email        citext NOT NULL,
  idempotency_key text NOT NULL UNIQUE,         -- also sent to Resend as Idempotency-Key
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','done','failed')),
  provider_id     text,
  error           text,
  attempts        int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- usage ledger

CREATE TABLE IF NOT EXISTS usage (
  id                  bigserial PRIMARY KEY,
  created_at          timestamptz NOT NULL DEFAULT now(),
  user_id             uuid REFERENCES users(id) ON DELETE SET NULL,
  conversation_id     uuid REFERENCES conversations(id) ON DELETE SET NULL,
  run_id              uuid REFERENCES runs(id) ON DELETE SET NULL,
  message_id          uuid REFERENCES messages(id) ON DELETE SET NULL,
  file_id             uuid REFERENCES files(id) ON DELETE SET NULL,
  kind                text NOT NULL CHECK (kind IN ('llm','embedding','web_search')),
  task                text NOT NULL,            -- simple_question | short_reply | email | file_analysis | fill_blank | web_search | generate | complex_reasoning | classify | embed
  tier                text,                     -- fast | standard | advanced (null for embeddings/web)
  model_id            text,
  input_tokens        int NOT NULL DEFAULT 0,
  output_tokens       int NOT NULL DEFAULT 0,
  cache_read_tokens   int NOT NULL DEFAULT 0,
  cache_write_tokens  int NOT NULL DEFAULT 0,
  units               int NOT NULL DEFAULT 0,   -- web search calls
  cost_usd            numeric(12,6) NOT NULL DEFAULT 0,
  escalated_from      text,                     -- tier it was retried from
  meta                jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS usage_created_idx ON usage(created_at);
CREATE INDEX IF NOT EXISTS usage_conv_idx ON usage(conversation_id);
CREATE INDEX IF NOT EXISTS usage_run_idx ON usage(run_id);

-- ---------------------------------------------------------------- shared SQL helpers
-- Used by both web (TypeScript) and worker (Python) so the rules live in one place.

-- Chat unlock: at least one analysed reference estimate.
CREATE OR REPLACE FUNCTION chat_unlocked() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM files
                 WHERE tag = 'reference_estimate' AND status = 'analysed' AND deleted_at IS NULL);
$$;

-- Budget state for the current calendar month (UTC).
-- state: ok | near | over ; action: pause | fast_only | warn
CREATE OR REPLACE FUNCTION budget_status()
RETURNS TABLE (spent_usd numeric, amount_usd numeric, alert_pct int, action text, state text)
LANGUAGE sql STABLE AS $$
  WITH b AS (
    SELECT COALESCE((value->>'monthly_usd')::numeric, 0)       AS amount,
           COALESCE((value->>'alert_pct')::int, 80)             AS alert_pct,
           COALESCE(value->>'over_action', 'warn')              AS action
      FROM settings WHERE key = 'budget'
    UNION ALL SELECT 0, 80, 'warn' WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'budget')
  ), s AS (
    SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM usage
     WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  )
  SELECT s.spent, b.amount, b.alert_pct, b.action,
         CASE WHEN b.amount <= 0 THEN 'ok'
              WHEN s.spent >= b.amount THEN 'over'
              WHEN s.spent >= b.amount * b.alert_pct / 100.0 THEN 'near'
              ELSE 'ok' END
    FROM b, s LIMIT 1;
$$;
