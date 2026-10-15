-- Which AI model answers the portal assistant, per organisation: Gemini (the default, as before), OpenAI
-- or Anthropic, each with the organisation's own API key.
ALTER TABLE wk_tenants
  ADD COLUMN IF NOT EXISTS chat_provider VARCHAR(12) NOT NULL DEFAULT 'gemini',
  ADD COLUMN IF NOT EXISTS chat_model    VARCHAR(60);                 -- NULL = the provider default

DO $$ BEGIN
  ALTER TABLE wk_tenants ADD CONSTRAINT wk_tenants_chat_provider CHECK (chat_provider IN ('gemini','openai','anthropic'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE wk_tenant_credentials DROP CONSTRAINT IF EXISTS wk_tenant_credentials_kind;
ALTER TABLE wk_tenant_credentials ADD CONSTRAINT wk_tenant_credentials_kind
  CHECK (kind IN ('orderful','workato','gemini','brevo','jira','servicenow','openai','anthropic'));
