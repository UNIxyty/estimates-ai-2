-- 0002: column layout of produced documents (which cells hold per-unit / row-total / source values),
-- so viewer edits can rewrite exactly the value cells later. Additive.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS layout jsonb NOT NULL DEFAULT '{}';
ALTER TABLE estimate_rows ADD COLUMN IF NOT EXISTS model_used boolean NOT NULL DEFAULT false;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS stats jsonb NOT NULL DEFAULT '{}';
