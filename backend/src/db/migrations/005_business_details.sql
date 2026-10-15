-- Business details extracted from the converted X12 (ship from/to, amounts, dates,
-- reference numbers, line items). Filled by the raw-EDI worker after /v3/convert.
--
-- These are customer business data, deliberately kept apart from raw_edi: the raw
-- payload stays encrypted and role-gated, while these fields are what business
-- analysts and executives read, so every role in the tenant can see them.

ALTER TABLE wk_transactions ADD COLUMN IF NOT EXISTS primary_label  VARCHAR(30);
ALTER TABLE wk_transactions ADD COLUMN IF NOT EXISTS po_number      VARCHAR(100);
ALTER TABLE wk_transactions ADD COLUMN IF NOT EXISTS shipment_number VARCHAR(100);
ALTER TABLE wk_transactions ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(100);
ALTER TABLE wk_transactions ADD COLUMN IF NOT EXISTS bol_number     VARCHAR(100);
-- Everything the parser found (po, shipment, invoice, bol, booking, order, carrier ref, scac)
ALTER TABLE wk_transactions ADD COLUMN IF NOT EXISTS business_keys  JSONB NOT NULL DEFAULT '{}';
ALTER TABLE wk_transactions ADD COLUMN IF NOT EXISTS ship_from      VARCHAR(255);
ALTER TABLE wk_transactions ADD COLUMN IF NOT EXISTS ship_to        VARCHAR(255);
ALTER TABLE wk_transactions ADD COLUMN IF NOT EXISTS sold_to        VARCHAR(255);
ALTER TABLE wk_transactions ADD COLUMN IF NOT EXISTS total_amount   NUMERIC(18,2);
ALTER TABLE wk_transactions ADD COLUMN IF NOT EXISTS currency       VARCHAR(3);
ALTER TABLE wk_transactions ADD COLUMN IF NOT EXISTS document_date  DATE;
-- Per-transaction-set detail (line items, stops, charges...) in the shape the detail cards read
ALTER TABLE wk_transactions ADD COLUMN IF NOT EXISTS edi_details    JSONB;
ALTER TABLE wk_transactions ADD COLUMN IF NOT EXISTS details_extracted_at TIMESTAMPTZ;

-- The identifiers an analyst searches by
CREATE INDEX IF NOT EXISTS idx_wk_txn_po       ON wk_transactions(tenant_id, upper(po_number));
CREATE INDEX IF NOT EXISTS idx_wk_txn_shipment ON wk_transactions(tenant_id, upper(shipment_number));
CREATE INDEX IF NOT EXISTS idx_wk_txn_invoice  ON wk_transactions(tenant_id, upper(invoice_number));
CREATE INDEX IF NOT EXISTS idx_wk_txn_bol      ON wk_transactions(tenant_id, upper(bol_number));

-- Gemini (Explain EDI) and Brevo (email alerts) keys per tenant, saved on the tenant page like the Orderful key.
-- For Brevo, `extra.senderEmail` holds the From address; the key itself is only ever in secret_enc.
ALTER TABLE wk_tenant_credentials DROP CONSTRAINT IF EXISTS wk_tenant_credentials_kind;
ALTER TABLE wk_tenant_credentials ADD CONSTRAINT wk_tenant_credentials_kind CHECK (kind IN ('orderful','workato','gemini','brevo'));
