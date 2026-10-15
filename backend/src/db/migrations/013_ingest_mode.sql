-- Which Workato jobs are EDI. Workato produces logs for every recipe, most of them nothing to do with
-- EDI, so ingestion decides per job and per recipe whether to keep it:
--   include  an admin marked the recipe as part of an EDI flow (any stage: SAP -> staging, staging -> Orderful, ...)
--   ignore   an admin marked it as not EDI
--   auto     decided from the job itself (Orderful step, X12 message, EDI in the recipe name)
-- A recipe that has ever shown EDI signals is remembered (edi_seen_at), so its later jobs are kept even
-- when they fail before reaching an Orderful step. Ignored jobs are counted, never stored.

ALTER TABLE wk_recipe_configs
  ADD COLUMN IF NOT EXISTS ingest_mode         VARCHAR(10) NOT NULL DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS edi_seen_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ignored_count       BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_ignored_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_ignored_reason VARCHAR(100);

ALTER TABLE wk_recipe_configs DROP CONSTRAINT IF EXISTS wk_recipe_configs_ingest_mode;
ALTER TABLE wk_recipe_configs ADD CONSTRAINT wk_recipe_configs_ingest_mode CHECK (ingest_mode IN ('auto','include','ignore'));

-- Recipes already ingested before this existed were kept on purpose: remember them as EDI so nothing
-- that worked yesterday is filtered out today.
UPDATE wk_recipe_configs c SET edi_seen_at = NOW()
 WHERE edi_seen_at IS NULL
   AND EXISTS (SELECT 1 FROM wk_executions e WHERE e.tenant_id = c.tenant_id AND e.recipe_id = c.recipe_id);
