-- Ingestion: raw source events, quarantine, per-recipe config

-- One row per Workato job log accepted for a tenant. Raw log is kept unmodified;
-- normalization (next slice) reads from here. JSONB for now - move to encrypted
-- object storage before production (see docs/SPEC.md, open items).
CREATE TABLE IF NOT EXISTS wk_source_events (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES wk_tenants(id) ON DELETE CASCADE,
  event_id         UUID NOT NULL,
  schema_version   INTEGER NOT NULL,
  source_mode      VARCHAR(10) NOT NULL,
  -- account_id:child_job_id. Unique per tenant so push and poll never double-count.
  dedup_key        VARCHAR(255) NOT NULL,
  workato_account_id VARCHAR(64) NOT NULL,
  recipe_id        VARCHAR(32) NOT NULL,
  job_id           VARCHAR(64) NOT NULL,
  master_job_id    VARCHAR(64),
  parent_job_id    VARCHAR(64),
  source_status    VARCHAR(30) NOT NULL,
  started_at       TIMESTAMPTZ NOT NULL,
  completed_at     TIMESTAMPTZ,
  received_at      TIMESTAMPTZ NOT NULL,
  stored_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set by the normalization worker
  normalized_at    TIMESTAMPTZ,
  raw_job          JSONB NOT NULL,
  CONSTRAINT wk_source_events_dedup UNIQUE (tenant_id, dedup_key)
);

CREATE INDEX IF NOT EXISTS idx_wk_source_events_tenant_time ON wk_source_events(tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_wk_source_events_unnormalized ON wk_source_events(tenant_id, id) WHERE normalized_at IS NULL;

-- Events refused at the door. Not published; kept for inspection and replay.
CREATE TABLE IF NOT EXISTS wk_ingest_quarantine (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    INTEGER NOT NULL REFERENCES wk_tenants(id) ON DELETE CASCADE,
  reason       VARCHAR(50) NOT NULL,
  detail       TEXT,
  -- true: the sender can fix and resend (bad shape). false: will never succeed as-is (wrong account).
  retriable    BOOLEAN NOT NULL,
  source_mode  VARCHAR(10) NOT NULL DEFAULT 'push',
  payload      JSONB,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  replayed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_wk_quarantine_tenant ON wk_ingest_quarantine(tenant_id, received_at DESC);

-- Per-recipe overrides for what cannot be inferred from the log (direction,
-- document type, which step carries the payload). Used by normalization.
CREATE TABLE IF NOT EXISTS wk_recipe_configs (
  id               SERIAL PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES wk_tenants(id) ON DELETE CASCADE,
  recipe_id        VARCHAR(32) NOT NULL,
  recipe_name      VARCHAR(255),
  direction        VARCHAR(10),
  document_type    VARCHAR(10),
  payload_step     INTEGER,
  target_system    VARCHAR(30),
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wk_recipe_configs_direction CHECK (direction IS NULL OR direction IN ('inbound','outbound')),
  CONSTRAINT wk_recipe_configs_unique UNIQUE (tenant_id, recipe_id)
);

DROP TRIGGER IF EXISTS wk_recipe_configs_updated_at ON wk_recipe_configs;
CREATE TRIGGER wk_recipe_configs_updated_at BEFORE UPDATE ON wk_recipe_configs
  FOR EACH ROW EXECUTE FUNCTION wk_set_updated_at();
