-- Keep portal tickets in step with Jira / ServiceNow: the latest status, assignee and comments, read
-- on a schedule and whenever someone opens the ticket, and comments or status changes made here.

ALTER TABLE wk_tickets
  ADD COLUMN IF NOT EXISTS external_ref      VARCHAR(80),        -- ServiceNow sys_id (Jira uses the key)
  ADD COLUMN IF NOT EXISTS status            VARCHAR(80),
  ADD COLUMN IF NOT EXISTS status_category   VARCHAR(12),        -- open | in_progress | done
  ADD COLUMN IF NOT EXISTS assignee          VARCHAR(120),
  ADD COLUMN IF NOT EXISTS external_priority VARCHAR(40),
  ADD COLUMN IF NOT EXISTS external_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS synced_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_sync_at      TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS sync_error        TEXT;

CREATE INDEX IF NOT EXISTS wk_tickets_sync ON wk_tickets (next_sync_at) WHERE next_sync_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS wk_tickets_tenant ON wk_tickets (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS wk_ticket_comments (
  id           BIGSERIAL PRIMARY KEY,
  ticket_id    BIGINT NOT NULL REFERENCES wk_tickets(id) ON DELETE CASCADE,
  external_id  VARCHAR(80) NOT NULL,
  author       VARCHAR(120),
  body         TEXT NOT NULL,
  -- 'portal' = written here by a portal user (posted under the service account), 'external' = written in the ticket system
  source       VARCHAR(10) NOT NULL DEFAULT 'external',
  posted_by    UUID REFERENCES wk_users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  CONSTRAINT wk_ticket_comments_unique UNIQUE (ticket_id, external_id)
);
CREATE INDEX IF NOT EXISTS wk_ticket_comments_ticket ON wk_ticket_comments (ticket_id, created_at);
