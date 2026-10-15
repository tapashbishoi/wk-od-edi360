-- EDI Workato Portal - foundation
-- Every object is wk_-prefixed so this can share a database with edi-360-tracking.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Shared updated_at trigger function. Named distinctly from edi-360's.
CREATE OR REPLACE FUNCTION wk_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- TENANTS
-- ============================================================
CREATE TABLE IF NOT EXISTS wk_tenants (
  id                  SERIAL PRIMARY KEY,
  slug                VARCHAR(41)  NOT NULL UNIQUE,
  name                VARCHAR(255) NOT NULL UNIQUE,
  status              VARCHAR(30)  NOT NULL DEFAULT 'draft',
  plan                VARCHAR(50)  NOT NULL DEFAULT 'standard',
  timezone            VARCHAR(64)  NOT NULL DEFAULT 'UTC',
  retention_days      INTEGER,
  source_mode         VARCHAR(10)  NOT NULL DEFAULT 'push',
  -- Workato account that owns this tenant's jobs; when set, ingest rejects events from any other account
  workato_account_id  VARCHAR(64),
  -- Generated from slug at creation, never typed free-form
  queue_name          VARCHAR(255) NOT NULL UNIQUE,
  dlq_name            VARCHAR(255) NOT NULL UNIQUE,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT wk_tenants_status CHECK (status IN ('draft','validation_pending','active','suspended','offboarded')),
  CONSTRAINT wk_tenants_source_mode CHECK (source_mode IN ('push','poll')),
  CONSTRAINT wk_tenants_slug CHECK (slug ~ '^[a-z][a-z0-9_]{1,40}$')
);

DROP TRIGGER IF EXISTS wk_tenants_updated_at ON wk_tenants;
CREATE TRIGGER wk_tenants_updated_at BEFORE UPDATE ON wk_tenants
  FOR EACH ROW EXECUTE FUNCTION wk_set_updated_at();

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE IF NOT EXISTS wk_users (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email          VARCHAR(255) NOT NULL UNIQUE,
  password_hash  VARCHAR(255),
  first_name     VARCHAR(255),
  last_name      VARCHAR(255),
  role           VARCHAR(30) NOT NULL DEFAULT 'support',
  tenant_id      INTEGER REFERENCES wk_tenants(id),
  is_active      BOOLEAN NOT NULL DEFAULT true,
  last_login     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wk_users_role CHECK (role IN ('platform_admin','customer_admin','support','business','auditor')),
  CONSTRAINT wk_users_platform_admin_no_tenant CHECK (
    (role = 'platform_admin' AND tenant_id IS NULL) OR (role <> 'platform_admin' AND tenant_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_wk_users_tenant_id ON wk_users(tenant_id);

DROP TRIGGER IF EXISTS wk_users_updated_at ON wk_users;
CREATE TRIGGER wk_users_updated_at BEFORE UPDATE ON wk_users
  FOR EACH ROW EXECUTE FUNCTION wk_set_updated_at();

-- ============================================================
-- API KEYS (ingestion authentication)
-- ============================================================
CREATE TABLE IF NOT EXISTS wk_api_keys (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     INTEGER NOT NULL REFERENCES wk_tenants(id) ON DELETE CASCADE,
  -- bcrypt hash; the key itself is shown once at creation and never stored
  key_hash      VARCHAR(255) NOT NULL,
  -- First 20 chars. Narrows the lookup to one bcrypt comparison instead of one per key.
  key_prefix    VARCHAR(20) NOT NULL,
  name          VARCHAR(255),
  created_by    UUID REFERENCES wk_users(id),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wk_api_keys_prefix ON wk_api_keys(key_prefix) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_wk_api_keys_tenant ON wk_api_keys(tenant_id);

-- ============================================================
-- TENANT CREDENTIALS (Orderful key, Workato token) - AES-256-GCM envelopes
-- ============================================================
CREATE TABLE IF NOT EXISTS wk_tenant_credentials (
  id             SERIAL PRIMARY KEY,
  tenant_id      INTEGER NOT NULL REFERENCES wk_tenants(id) ON DELETE CASCADE,
  kind           VARCHAR(20) NOT NULL,
  environment    VARCHAR(20) NOT NULL DEFAULT 'production',
  secret_enc     TEXT NOT NULL,
  -- Last 4 characters only, so the UI can show which key is in place without decrypting it
  secret_hint    VARCHAR(8),
  extra          JSONB NOT NULL DEFAULT '{}',
  rotated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wk_tenant_credentials_kind CHECK (kind IN ('orderful','workato')),
  CONSTRAINT wk_tenant_credentials_unique UNIQUE (tenant_id, kind, environment)
);

-- ============================================================
-- AUDIT LOG
-- ============================================================
CREATE TABLE IF NOT EXISTS wk_audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   INTEGER REFERENCES wk_tenants(id) ON DELETE SET NULL,
  actor_id    UUID,
  actor_role  VARCHAR(30),
  action      VARCHAR(80) NOT NULL,
  target      VARCHAR(255),
  outcome     VARCHAR(20) NOT NULL DEFAULT 'success',
  ip          VARCHAR(64),
  details     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wk_audit_tenant_time ON wk_audit_logs(tenant_id, created_at DESC);
