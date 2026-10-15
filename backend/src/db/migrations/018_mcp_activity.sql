-- Separate keys for separate jobs: an ingestion key (what Workato uses to push logs) cannot read data, and
-- an MCP key (read-only access for AI tools) cannot ingest. Existing keys stay ingestion keys.
ALTER TABLE wk_api_keys ADD COLUMN IF NOT EXISTS scope VARCHAR(10) NOT NULL DEFAULT 'ingest';
DO $$ BEGIN
  ALTER TABLE wk_api_keys ADD CONSTRAINT wk_api_keys_scope CHECK (scope IN ('ingest','mcp'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- What came in through the API, the MCP server and the assistant, so the platform owner can see whether
-- each is alive and who is hitting errors. Metadata only: never request bodies, keys or questions. Kept 30 days.
CREATE TABLE IF NOT EXISTS wk_api_activity (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    INTEGER REFERENCES wk_tenants(id) ON DELETE CASCADE,
  channel      VARCHAR(10) NOT NULL,           -- ingest | mcp | chat
  key_id       UUID,
  action       VARCHAR(60) NOT NULL,           -- ingest, or the MCP method / tool name
  status       VARCHAR(8) NOT NULL,            -- ok | error
  http_status  INTEGER,
  duration_ms  INTEGER,
  detail       VARCHAR(300),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wk_api_activity_channel CHECK (channel IN ('ingest','mcp','chat'))
);
CREATE INDEX IF NOT EXISTS wk_api_activity_recent ON wk_api_activity (created_at DESC);
CREATE INDEX IF NOT EXISTS wk_api_activity_tenant ON wk_api_activity (tenant_id, channel, created_at DESC);
