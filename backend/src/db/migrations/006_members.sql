-- Tenant members: invitations that let a customer's people set a password and sign in.
--
-- A member is a wk_users row with a tenant_id and a role. It is created without a
-- password (password_hash NULL, which can never match a login) and becomes usable
-- when its invitation is accepted. Only a SHA-256 of the invitation token is
-- stored, like an API key: a database leak does not leak working invite links.

CREATE TABLE IF NOT EXISTS wk_invitations (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES wk_tenants(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES wk_users(id) ON DELETE CASCADE,
  token_hash  CHAR(64) NOT NULL UNIQUE,
  created_by  UUID REFERENCES wk_users(id) ON DELETE SET NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wk_invitations_user ON wk_invitations(user_id);
CREATE INDEX IF NOT EXISTS idx_wk_invitations_tenant ON wk_invitations(tenant_id);
