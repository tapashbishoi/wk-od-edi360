-- Trading partners seen in traffic, their 997 tracking switches, and the document sequence
-- (flow) expected with each. Partners are not created by hand: a partner is the far end of a
-- transaction (sender when inbound, receiver when outbound), identified by its ISA id.

CREATE TABLE IF NOT EXISTS wk_partner_settings (
  id                    SERIAL PRIMARY KEY,
  tenant_id             INTEGER NOT NULL REFERENCES wk_tenants(id) ON DELETE CASCADE,
  partner_id            VARCHAR(40) NOT NULL,
  -- Show the 997 we send for inbound documents / expect a 997 back for outbound ones
  track_inbound_ack     BOOLEAN NOT NULL DEFAULT TRUE,
  expect_outbound_ack   BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wk_partner_settings_unique UNIQUE (tenant_id, partner_id)
);

CREATE TABLE IF NOT EXISTS wk_partner_flows (
  id          SERIAL PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES wk_tenants(id) ON DELETE CASCADE,
  partner_id  VARCHAR(40) NOT NULL,
  name        VARCHAR(80) NOT NULL,
  -- [{docType, direction, multiple, optional, slaMinutes}] in expected order
  steps       JSONB NOT NULL,
  created_by  UUID REFERENCES wk_users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wk_partner_flows_unique UNIQUE (tenant_id, partner_id, name)
);

DROP TRIGGER IF EXISTS wk_partner_flows_updated_at ON wk_partner_flows;
CREATE TRIGGER wk_partner_flows_updated_at BEFORE UPDATE ON wk_partner_flows
  FOR EACH ROW EXECUTE FUNCTION wk_set_updated_at();

CREATE INDEX IF NOT EXISTS wk_transactions_partner_idx ON wk_transactions (tenant_id, direction, sender_id, receiver_id);
