-- Where a transaction's business details came from, so a better source is never overwritten by a worse one:
--   'log' = read from the Orderful message JSON inside the Workato job log (immediate, no Orderful call)
--   'edi' = parsed from the X12 that Orderful's /v3/convert returned (authoritative: it is the document itself)
ALTER TABLE wk_transactions ADD COLUMN IF NOT EXISTS details_source VARCHAR(8);
-- Everything extracted before this column existed came from converted X12
UPDATE wk_transactions SET details_source = 'edi' WHERE details_extracted_at IS NOT NULL AND details_source IS NULL;
ALTER TABLE wk_transactions DROP CONSTRAINT IF EXISTS wk_transactions_details_source;
ALTER TABLE wk_transactions ADD CONSTRAINT wk_transactions_details_source CHECK (details_source IS NULL OR details_source IN ('log','edi'));
