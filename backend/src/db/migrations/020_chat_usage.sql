-- What each assistant question actually used, so the platform owner and each organisation can see real
-- token counts and cost instead of an estimate. Counts only; never the question or the answer.
ALTER TABLE wk_api_activity
  ADD COLUMN IF NOT EXISTS provider      VARCHAR(12),
  ADD COLUMN IF NOT EXISTS model         VARCHAR(60),
  ADD COLUMN IF NOT EXISTS input_tokens  INTEGER,
  ADD COLUMN IF NOT EXISTS output_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS cached_tokens INTEGER,
  -- Worked out when the question was asked, at the price then; NULL when the model's price is not known
  ADD COLUMN IF NOT EXISTS cost_usd      NUMERIC(10,6);

-- Explain EDI is tracked on its own channel next to the chat
ALTER TABLE wk_api_activity DROP CONSTRAINT IF EXISTS wk_api_activity_channel;
ALTER TABLE wk_api_activity ADD CONSTRAINT wk_api_activity_channel CHECK (channel IN ('ingest','mcp','chat','explain'));
