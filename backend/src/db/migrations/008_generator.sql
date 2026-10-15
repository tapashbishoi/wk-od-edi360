-- Test EDI generator: trading partner profiles and a history of generated files.

-- A partner profile is the envelope identity (ISA/GS ids, version, delimiters), default parties and
-- references, and per-document rules. Kept as one validated JSON document (normalizePartner on every
-- write); the control-number counters are real columns so they can be advanced atomically.
CREATE TABLE IF NOT EXISTS wk_trading_partners (
  id                SERIAL PRIMARY KEY,
  tenant_id         INTEGER NOT NULL REFERENCES wk_tenants(id) ON DELETE CASCADE,
  name              VARCHAR(80) NOT NULL,
  code              VARCHAR(20) NOT NULL,
  profile           JSONB NOT NULL,
  -- Next ISA13 and GS06 to use. Every generated file takes the next value, so two files never share
  -- an interchange control number (receivers flag a repeat as a duplicate and drop the file).
  isa_control_next  BIGINT NOT NULL DEFAULT 1,
  gs_control_next   BIGINT NOT NULL DEFAULT 1,
  created_by        UUID REFERENCES wk_users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wk_trading_partners_name UNIQUE (tenant_id, name),
  CONSTRAINT wk_trading_partners_isa CHECK (isa_control_next BETWEEN 1 AND 999999999),
  CONSTRAINT wk_trading_partners_gs CHECK (gs_control_next BETWEEN 1 AND 999999999)
);

DROP TRIGGER IF EXISTS wk_trading_partners_updated_at ON wk_trading_partners;
CREATE TRIGGER wk_trading_partners_updated_at BEFORE UPDATE ON wk_trading_partners
  FOR EACH ROW EXECUTE FUNCTION wk_set_updated_at();

-- Every file the generator produced for download. These are test files built from form input, so
-- the content is kept as text and can be downloaded again.
CREATE TABLE IF NOT EXISTS wk_generated_files (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    INTEGER NOT NULL REFERENCES wk_tenants(id) ON DELETE CASCADE,
  -- Kept (as NULL) if the partner is later deleted: the history of what was sent should outlive the profile
  partner_id   INTEGER REFERENCES wk_trading_partners(id) ON DELETE SET NULL,
  partner_name VARCHAR(80),
  doc_type     VARCHAR(3) NOT NULL,
  sender       VARCHAR(7) NOT NULL,
  filename     VARCHAR(200) NOT NULL,
  content      TEXT NOT NULL,
  isa_control  VARCHAR(9),
  gs_control   VARCHAR(9),
  segments     INTEGER,
  warnings     INTEGER NOT NULL DEFAULT 0,
  created_by   UUID REFERENCES wk_users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wk_generated_tenant_time ON wk_generated_files(tenant_id, created_at DESC);
