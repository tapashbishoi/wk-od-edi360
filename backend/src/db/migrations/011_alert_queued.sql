-- A freshly claimed alert waits as 'queued'; 'sending' means a worker has it right now. Keeping the
-- two apart is what stops a second worker picking up a send that is already in flight.
ALTER TABLE wk_alert_dispatches DROP CONSTRAINT IF EXISTS wk_alert_dispatch_status;
ALTER TABLE wk_alert_dispatches ADD CONSTRAINT wk_alert_dispatch_status CHECK (status IN ('queued','sending','sent','failed','given_up'));
ALTER TABLE wk_alert_dispatches ALTER COLUMN status SET DEFAULT 'queued';
UPDATE wk_alert_dispatches SET status = 'queued' WHERE status = 'sending' AND attempts = 0;
