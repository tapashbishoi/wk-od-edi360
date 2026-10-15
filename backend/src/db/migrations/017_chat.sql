-- The portal assistant: a per-tenant switch and daily message cap, and a usage counter.
-- Conversation text is not stored; only how many messages a tenant used each day.

ALTER TABLE wk_tenants
  ADD COLUMN IF NOT EXISTS chat_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS chat_daily_limit INTEGER;   -- NULL = the platform default

CREATE TABLE IF NOT EXISTS wk_chat_usage (
  tenant_id  INTEGER NOT NULL REFERENCES wk_tenants(id) ON DELETE CASCADE,
  day        DATE NOT NULL,
  messages   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);
