-- Raw EDI enrichment (Orderful /v3/convert)

-- Off by default per tenant: raw EDI carries business and personal data, and the
-- payload policy (full / redacted / reference-only) is still an open decision.
ALTER TABLE wk_tenants ADD COLUMN IF NOT EXISTS raw_edi_enabled BOOLEAN NOT NULL DEFAULT false;

-- raw_edi_status: pending | converted | failed | unavailable
--   unavailable = no message JSON in any of the transaction's logs (terminal)
--   failed      = gave up (non-retriable error, or retries exhausted)
-- raw_edi holds an AES-256-GCM envelope, never plaintext. It is derivable again
-- from the source log, so rotating the encryption key costs a re-convert, not data.
ALTER TABLE wk_orderful_messages ADD COLUMN IF NOT EXISTS raw_edi_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wk_orderful_messages ADD COLUMN IF NOT EXISTS raw_edi_error TEXT;
ALTER TABLE wk_orderful_messages ADD COLUMN IF NOT EXISTS raw_edi_next_at TIMESTAMPTZ;
ALTER TABLE wk_orderful_messages ADD COLUMN IF NOT EXISTS raw_edi_converted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_wk_ofl_raw_pending
  ON wk_orderful_messages(tenant_id, raw_edi_next_at)
  WHERE raw_edi_status IN ('pending');
