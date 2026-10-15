-- Ticketing (Jira or ServiceNow, set up by the tenant's admin), the tickets raised from documents,
-- and the reports people email about a document.

-- Which ticket system the tenant uses. Its connection details live in wk_tenant_credentials
-- (kind 'jira' or 'servicenow'): the API token or password encrypted, everything else in `extra`.
ALTER TABLE wk_tenants ADD COLUMN IF NOT EXISTS ticket_provider VARCHAR(12);
ALTER TABLE wk_tenants DROP CONSTRAINT IF EXISTS wk_tenants_ticket_provider;
ALTER TABLE wk_tenants ADD CONSTRAINT wk_tenants_ticket_provider CHECK (ticket_provider IS NULL OR ticket_provider IN ('jira','servicenow'));

ALTER TABLE wk_tenant_credentials DROP CONSTRAINT IF EXISTS wk_tenant_credentials_kind;
ALTER TABLE wk_tenant_credentials ADD CONSTRAINT wk_tenant_credentials_kind CHECK (kind IN ('orderful','workato','gemini','brevo','jira','servicenow'));

-- A ticket raised from one or more documents.
CREATE TABLE IF NOT EXISTS wk_tickets (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES wk_tenants(id) ON DELETE CASCADE,
  provider      VARCHAR(12) NOT NULL,
  external_key  VARCHAR(60) NOT NULL,
  external_url  TEXT,
  summary       VARCHAR(300) NOT NULL,
  priority      VARCHAR(10) NOT NULL,
  reason        TEXT NOT NULL,
  created_by    UUID REFERENCES wk_users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS wk_ticket_transactions (
  ticket_id       BIGINT NOT NULL REFERENCES wk_tickets(id) ON DELETE CASCADE,
  transaction_id  BIGINT NOT NULL REFERENCES wk_transactions(id) ON DELETE CASCADE,
  PRIMARY KEY (ticket_id, transaction_id)
);
CREATE INDEX IF NOT EXISTS wk_ticket_transactions_txn ON wk_ticket_transactions (transaction_id);

-- Reports emailed about documents: who sent what to whom. Addresses are kept so the destination of a
-- report is auditable; the report itself is rebuilt from the document, not stored.
CREATE TABLE IF NOT EXISTS wk_report_emails (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  INTEGER NOT NULL REFERENCES wk_tenants(id) ON DELETE CASCADE,
  sent_by    UUID REFERENCES wk_users(id) ON DELETE SET NULL,
  recipients TEXT[] NOT NULL,
  subject    VARCHAR(200) NOT NULL,
  documents  INTEGER NOT NULL,
  status     VARCHAR(10) NOT NULL,
  error      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS wk_report_email_transactions (
  report_id       BIGINT NOT NULL REFERENCES wk_report_emails(id) ON DELETE CASCADE,
  transaction_id  BIGINT NOT NULL REFERENCES wk_transactions(id) ON DELETE CASCADE,
  PRIMARY KEY (report_id, transaction_id)
);
