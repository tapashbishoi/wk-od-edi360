-- Normalization: transactions, executions, Orderful messages, stages

-- A business transaction. Keyed per tenant by correlation_key: "orderful:<id>"
-- when the log names an Orderful transaction (the hub), else "job:<account:job>".
-- One transaction can have many executions (a re-poll, a retry, a rerun).
CREATE TABLE IF NOT EXISTS wk_transactions (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES wk_tenants(id) ON DELETE CASCADE,
  correlation_key  TEXT NOT NULL,
  direction        VARCHAR(10) NOT NULL DEFAULT 'unknown',
  document_type    VARCHAR(10),
  business_number  VARCHAR(100),
  environment      VARCHAR(12) NOT NULL DEFAULT 'unknown',
  sender_id        VARCHAR(64),
  sender_name      VARCHAR(255),
  receiver_id      VARCHAR(64),
  receiver_name    VARCHAR(255),
  -- Status of the most recent execution; recomputed whenever one is added or changes
  canonical_status VARCHAR(20) NOT NULL DEFAULT 'Unknown',
  failure_stage    VARCHAR(30),
  execution_count  INTEGER NOT NULL DEFAULT 0,
  first_seen_at    TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wk_transactions_key UNIQUE (tenant_id, correlation_key),
  CONSTRAINT wk_transactions_direction CHECK (direction IN ('inbound','outbound','ambiguous','unknown'))
);

CREATE INDEX IF NOT EXISTS idx_wk_txn_tenant_activity ON wk_transactions(tenant_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_wk_txn_tenant_business ON wk_transactions(tenant_id, upper(business_number));
CREATE INDEX IF NOT EXISTS idx_wk_txn_tenant_status ON wk_transactions(tenant_id, canonical_status);

DROP TRIGGER IF EXISTS wk_transactions_updated_at ON wk_transactions;
CREATE TRIGGER wk_transactions_updated_at BEFORE UPDATE ON wk_transactions
  FOR EACH ROW EXECUTE FUNCTION wk_set_updated_at();

-- One row per Workato job (source event). Step metadata only, never payload bodies.
CREATE TABLE IF NOT EXISTS wk_executions (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES wk_tenants(id) ON DELETE CASCADE,
  transaction_id   BIGINT NOT NULL REFERENCES wk_transactions(id) ON DELETE CASCADE,
  source_event_id  BIGINT NOT NULL UNIQUE REFERENCES wk_source_events(id) ON DELETE CASCADE,
  recipe_id        VARCHAR(32) NOT NULL,
  recipe_name      VARCHAR(255),
  job_id           VARCHAR(64) NOT NULL,
  parent_job_id    VARCHAR(64),
  master_job_id    VARCHAR(64),
  job_url          TEXT,
  direction        VARCHAR(10) NOT NULL,
  source_status    VARCHAR(30) NOT NULL,
  canonical_status VARCHAR(20) NOT NULL,
  failure_stage    VARCHAR(30),
  failure_step     INTEGER,
  failure_message  TEXT,
  started_at       TIMESTAMPTZ NOT NULL,
  completed_at     TIMESTAMPTZ,
  duration_ms      BIGINT,
  steps            JSONB NOT NULL DEFAULT '[]',
  erp              JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wk_exec_txn ON wk_executions(transaction_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_wk_exec_job ON wk_executions(tenant_id, job_id);
CREATE INDEX IF NOT EXISTS idx_wk_exec_parent ON wk_executions(tenant_id, parent_job_id);
CREATE INDEX IF NOT EXISTS idx_wk_exec_master ON wk_executions(tenant_id, master_job_id);
CREATE INDEX IF NOT EXISTS idx_wk_exec_recipe ON wk_executions(tenant_id, recipe_id, started_at DESC);

DROP TRIGGER IF EXISTS wk_executions_updated_at ON wk_executions;
CREATE TRIGGER wk_executions_updated_at BEFORE UPDATE ON wk_executions
  FOR EACH ROW EXECUTE FUNCTION wk_set_updated_at();

-- The Orderful side of a transaction. Latest observation wins (observed_at), so
-- a late-arriving older log can't overwrite newer state. raw_edi_* are filled by
-- the enrichment worker (next slice) and never touched by normalization.
CREATE TABLE IF NOT EXISTS wk_orderful_messages (
  id                    BIGSERIAL PRIMARY KEY,
  tenant_id             INTEGER NOT NULL REFERENCES wk_tenants(id) ON DELETE CASCADE,
  transaction_id        BIGINT NOT NULL REFERENCES wk_transactions(id) ON DELETE CASCADE,
  orderful_transaction_id VARCHAR(32) NOT NULL,
  type_name             VARCHAR(100),
  document_type         VARCHAR(10),
  business_number       VARCHAR(100),
  sender_isa_id         VARCHAR(64),
  sender_name           VARCHAR(255),
  receiver_isa_id       VARCHAR(64),
  receiver_name         VARCHAR(255),
  stream                VARCHAR(20),
  validation_status     VARCHAR(30),
  acknowledgment_status VARCHAR(30),
  delivery_status       VARCHAR(30),
  delivery_id           VARCHAR(64),
  isa_control_number    VARCHAR(20),
  gs_control_number     VARCHAR(20),
  st_control_number     VARCHAR(20),
  orderful_created_at   TIMESTAMPTZ,
  orderful_updated_at   TIMESTAMPTZ,
  observed_at           TIMESTAMPTZ NOT NULL,
  raw_edi               TEXT,
  raw_edi_status        VARCHAR(20) NOT NULL DEFAULT 'pending',
  raw_edi_hash          VARCHAR(64),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wk_orderful_messages_unique UNIQUE (tenant_id, orderful_transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_wk_ofl_txn ON wk_orderful_messages(transaction_id);
CREATE INDEX IF NOT EXISTS idx_wk_ofl_isa ON wk_orderful_messages(tenant_id, isa_control_number);
CREATE INDEX IF NOT EXISTS idx_wk_ofl_gs ON wk_orderful_messages(tenant_id, gs_control_number);

-- The three lanes of the detail page, one row per execution per lane.
CREATE TABLE IF NOT EXISTS wk_transaction_stages (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES wk_tenants(id) ON DELETE CASCADE,
  transaction_id   BIGINT NOT NULL REFERENCES wk_transactions(id) ON DELETE CASCADE,
  execution_id     BIGINT NOT NULL REFERENCES wk_executions(id) ON DELETE CASCADE,
  stage_type       VARCHAR(10) NOT NULL,
  canonical_status VARCHAR(20) NOT NULL,
  source_status    VARCHAR(50),
  started_at       TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ,
  CONSTRAINT wk_stages_type CHECK (stage_type IN ('orderful','workato','erp')),
  CONSTRAINT wk_stages_unique UNIQUE (execution_id, stage_type)
);

CREATE INDEX IF NOT EXISTS idx_wk_stages_txn ON wk_transaction_stages(transaction_id);

-- Normalization bookkeeping on the raw events
ALTER TABLE wk_source_events ADD COLUMN IF NOT EXISTS normalize_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wk_source_events ADD COLUMN IF NOT EXISTS normalize_error TEXT;
