-- My View (a user's default partner/document filter), email alert subscriptions with their
-- dispatch log, and cached Explain EDI results.

-- [{partner, types[]}]. A display preference, never an access control: it decides what a user is
-- shown by default and is cleared in one click. Pairs rather than two lists, so "Walmart 850s and
-- Target 856s" does not also match Walmart 856s.
ALTER TABLE wk_users ADD COLUMN IF NOT EXISTS saved_view JSONB NOT NULL DEFAULT '[]'::jsonb;

-- "Mail me when this partner's document of this type succeeds / fails." NULL partner or type = any.
CREATE TABLE IF NOT EXISTS wk_alert_subscriptions (
  id              SERIAL PRIMARY KEY,
  tenant_id       INTEGER NOT NULL REFERENCES wk_tenants(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES wk_users(id) ON DELETE CASCADE,
  partner_id      VARCHAR(40),
  document_type   VARCHAR(10),
  trigger_event   VARCHAR(10) NOT NULL DEFAULT 'failure',
  -- The address at subscribe time, so a dispatch needs no join and the destination is auditable
  email           VARCHAR(255) NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wk_alert_trigger CHECK (trigger_event IN ('success','failure','both'))
);
CREATE UNIQUE INDEX IF NOT EXISTS wk_alert_sub_unique
  ON wk_alert_subscriptions (user_id, tenant_id, COALESCE(partner_id,'*'), COALESCE(document_type,'*'));
CREATE INDEX IF NOT EXISTS wk_alert_sub_tenant ON wk_alert_subscriptions (tenant_id) WHERE is_active;

-- One row per (subscription, transaction, event): a transaction cannot notify twice for the same
-- event, however many times it is re-ingested or re-normalized. The row is the claim, made before
-- sending, so two workers cannot both send it.
CREATE TABLE IF NOT EXISTS wk_alert_dispatches (
  id               BIGSERIAL PRIMARY KEY,
  subscription_id  INTEGER NOT NULL REFERENCES wk_alert_subscriptions(id) ON DELETE CASCADE,
  transaction_id   BIGINT NOT NULL REFERENCES wk_transactions(id) ON DELETE CASCADE,
  event            VARCHAR(10) NOT NULL,
  status           VARCHAR(10) NOT NULL DEFAULT 'sending',
  attempts         INTEGER NOT NULL DEFAULT 0,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wk_alert_dispatch_unique UNIQUE (subscription_id, transaction_id, event),
  CONSTRAINT wk_alert_dispatch_status CHECK (status IN ('sending','sent','failed','given_up'))
);

-- Explain EDI results, one per transaction and language. raw_hash ties the text to the EDI it
-- explained, so a re-converted document is not served a stale explanation.
CREATE TABLE IF NOT EXISTS wk_edi_explanations (
  tenant_id       INTEGER NOT NULL REFERENCES wk_tenants(id) ON DELETE CASCADE,
  transaction_id  BIGINT NOT NULL REFERENCES wk_transactions(id) ON DELETE CASCADE,
  language        VARCHAR(30) NOT NULL,
  raw_hash        VARCHAR(64) NOT NULL,
  html            TEXT NOT NULL,
  model           VARCHAR(60),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (transaction_id, language)
);
