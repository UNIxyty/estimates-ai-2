-- 0005: estimates produced from unit-rate BOQs (Total = Quantity x Rate, no hours). Additive.
-- A unit-rate row keeps its install EUR/unit in unit_labour and supply EUR/unit in unit_material (so totals, the
-- viewer and Q&A keep working); these columns say how each value was found.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS pricing_model text NOT NULL DEFAULT 'hourly_norm'
  CHECK (pricing_model IN ('hourly_norm', 'unit_rate'));
ALTER TABLE documents ADD COLUMN IF NOT EXISTS checks jsonb NOT NULL DEFAULT '{}';
  -- {recalculated, problems[], totals{sheet:{total,supply_total}}, summary{label:value}, ratio_checks[],
  --  skipped_sheets[], not_priced[]}

ALTER TABLE estimate_rows ADD COLUMN IF NOT EXISTS row_kind text;        -- item | contractor | lump_sum | delivery | prelim
ALTER TABLE estimate_rows ADD COLUMN IF NOT EXISTS rate_basis text;      -- install_only | supply_and_install | …
ALTER TABLE estimate_rows ADD COLUMN IF NOT EXISTS install_method text;  -- exact | item | band | text | similar | web
ALTER TABLE estimate_rows ADD COLUMN IF NOT EXISTS supply_method text;
ALTER TABLE estimate_rows ADD COLUMN IF NOT EXISTS note text;            -- "interpolated from band 300–400 mm …"
ALTER TABLE estimate_rows ADD COLUMN IF NOT EXISTS alternatives jsonb NOT NULL DEFAULT '[]';
  -- [{file_name, rate, which: install|supply}]  (the spread shown in the row inspector)
ALTER TABLE estimate_rows ADD COLUMN IF NOT EXISTS amount numeric(18,4); -- lump sum / delivery money
