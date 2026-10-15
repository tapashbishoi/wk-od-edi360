-- Orderful's own view of a transaction we SENT (GET /v3/transactions/{id}): validation, delivery and
-- acknowledgment status. An outbound Workato log only says the transaction was created, so the portal
-- asks Orderful and keeps checking until the outcome is final.

ALTER TABLE wk_orderful_messages
  ADD COLUMN IF NOT EXISTS status_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status_next_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status_attempts   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status_error      TEXT;

CREATE INDEX IF NOT EXISTS wk_orderful_messages_status_due
  ON wk_orderful_messages (status_next_at NULLS FIRST) WHERE status_checked_at IS NULL OR status_next_at IS NOT NULL;
