-- Rule-based "997 still pending" reminders. A rule says: for this partner (or all), documents of
-- these types, if the acknowledgment has not come back after N hours, email this list of people at
-- these times of day (tenant time zone). Separate from per-user alert subscriptions.

CREATE TABLE IF NOT EXISTS wk_ack_rules (
  id              SERIAL PRIMARY KEY,
  tenant_id       INTEGER NOT NULL REFERENCES wk_tenants(id) ON DELETE CASCADE,
  name            VARCHAR(80) NOT NULL,
  -- NULL = every partner / every document type
  partner_id      VARCHAR(40),
  document_types  TEXT[],
  direction       VARCHAR(10) NOT NULL DEFAULT 'both',
  threshold_hours INTEGER NOT NULL DEFAULT 24,
  recipients      TEXT[] NOT NULL,
  -- 'HH:MM' in the tenant's time zone, e.g. {08:00,17:00}; empty = on demand only
  send_times      TEXT[] NOT NULL DEFAULT '{}',
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at     TIMESTAMPTZ,
  last_run_status VARCHAR(20),
  last_run_count  INTEGER,
  created_by      UUID REFERENCES wk_users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wk_ack_rules_direction CHECK (direction IN ('outbound','inbound','both')),
  CONSTRAINT wk_ack_rules_threshold CHECK (threshold_hours BETWEEN 1 AND 720)
);
CREATE INDEX IF NOT EXISTS wk_ack_rules_tenant ON wk_ack_rules (tenant_id);

DROP TRIGGER IF EXISTS wk_ack_rules_updated_at ON wk_ack_rules;
CREATE TRIGGER wk_ack_rules_updated_at BEFORE UPDATE ON wk_ack_rules
  FOR EACH ROW EXECUTE FUNCTION wk_set_updated_at();

-- One row per run. A scheduled run is claimed by inserting (rule_id, slot) first, so two workers
-- (or a restart in the same minute) cannot send the same morning report twice.
CREATE TABLE IF NOT EXISTS wk_ack_rule_runs (
  id             BIGSERIAL PRIMARY KEY,
  rule_id        INTEGER NOT NULL REFERENCES wk_ack_rules(id) ON DELETE CASCADE,
  tenant_id      INTEGER NOT NULL,
  trigger_kind   VARCHAR(10) NOT NULL,
  slot           VARCHAR(20),
  pending_count  INTEGER NOT NULL DEFAULT 0,
  sent           INTEGER NOT NULL DEFAULT 0,
  failed         INTEGER NOT NULL DEFAULT 0,
  status         VARCHAR(12) NOT NULL DEFAULT 'running',
  error          TEXT,
  run_by         UUID REFERENCES wk_users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wk_ack_rule_runs_trigger CHECK (trigger_kind IN ('schedule','manual'))
);
CREATE UNIQUE INDEX IF NOT EXISTS wk_ack_rule_runs_slot ON wk_ack_rule_runs (rule_id, slot) WHERE slot IS NOT NULL;
CREATE INDEX IF NOT EXISTS wk_ack_rule_runs_rule ON wk_ack_rule_runs (rule_id, created_at DESC);
