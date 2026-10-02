-- 0004: unit-rate BOQs (EU data-centre subcontract BOQs: Total = Quantity × Rate, no hours, no hourly rate) next to the
-- Latvian hourly-norm tāmes. Every reference, sheet and price item says which pricing model it follows; the matcher
-- only uses references of the run's model. Additive: existing rows default to 'hourly_norm'.

ALTER TABLE files ADD COLUMN IF NOT EXISTS pricing_model text NOT NULL DEFAULT 'hourly_norm';
ALTER TABLE files ADD COLUMN IF NOT EXISTS market text;          -- LV / DE / NL … (project city, address, language)
ALTER TABLE files ADD COLUMN IF NOT EXISTS client text;          -- main contractor we price for (e.g. Winthrop)
ALTER TABLE files ADD COLUMN IF NOT EXISTS end_client text;      -- project owner (Goodman, NTT …)
ALTER TABLE files ADD COLUMN IF NOT EXISTS package text;         -- containment / lighting / gs_sp / cable / electrical
ALTER TABLE files ADD COLUMN IF NOT EXISTS project text;
ALTER TABLE files ADD COLUMN IF NOT EXISTS doc_date date;
ALTER TABLE files ADD COLUMN IF NOT EXISTS analysis jsonb NOT NULL DEFAULT '{}';   -- unit-rate analysis (file page)
DO $$ BEGIN
  ALTER TABLE files ADD CONSTRAINT files_pricing_model_chk CHECK (pricing_model IN ('hourly_norm', 'unit_rate'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS files_sha256_idx ON files(sha256) WHERE deleted_at IS NULL;

ALTER TABLE file_sheets ADD COLUMN IF NOT EXISTS pricing_model text NOT NULL DEFAULT 'hourly_norm';
ALTER TABLE file_sheets ADD COLUMN IF NOT EXISTS layout jsonb;   -- {layout:A|B|C, cols, phases, buildings, areas, …}

ALTER TABLE price_items ADD COLUMN IF NOT EXISTS pricing_model text NOT NULL DEFAULT 'hourly_norm';
ALTER TABLE price_items ADD COLUMN IF NOT EXISTS install_rate numeric(18,4);
ALTER TABLE price_items ADD COLUMN IF NOT EXISTS supply_rate numeric(18,4);
-- install_only | supply_only | supply_and_install | lump_sum | weekly | monthly | percent
ALTER TABLE price_items ADD COLUMN IF NOT EXISTS rate_basis text;
ALTER TABLE price_items ADD COLUMN IF NOT EXISTS package text;   -- containment / lighting / gs_sp / cable / prelims / contractor_items
ALTER TABLE price_items ADD COLUMN IF NOT EXISTS section_notes jsonb NOT NULL DEFAULT '[]';
ALTER TABLE price_items ADD COLUMN IF NOT EXISTS phase_qty jsonb NOT NULL DEFAULT '{}';
ALTER TABLE price_items ADD COLUMN IF NOT EXISTS rate_key text;  -- rate-card label ("Tray straight · 300 mm")
ALTER TABLE price_items ADD COLUMN IF NOT EXISTS flags jsonb NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS price_items_model_idx ON price_items(pricing_model, rate_key);
