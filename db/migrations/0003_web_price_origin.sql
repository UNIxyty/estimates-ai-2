-- 0003: where a web price came from (allowlisted supplier domain + its country). Additive.
ALTER TABLE web_prices ADD COLUMN IF NOT EXISTS domain text;
ALTER TABLE web_prices ADD COLUMN IF NOT EXISTS country text;
