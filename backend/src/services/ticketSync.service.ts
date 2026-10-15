import { query, queryOne, transaction } from '../db/connection.js';
import { logger } from '../utils/logger.js';
import { PORTAL_COMMENT_MARK, TicketError, fetchRemote, loadTicketConfig, type StatusCategory } from './ticketing.service.js';

/**
 * Keeps portal tickets in step with the ticket system. Read-only toward the ticket: it copies status,
 * assignee, priority and comments down. Open tickets are re-read every few minutes (less often as they
 * age); finished ones stop being polled, and are read again only when someone opens or refreshes them.
 */

const BATCH = 20;

/** Minutes until the next read of an unfinished ticket: soon at first, then calmer. */
export function nextSyncMinutes(createdAt: Date | string, category: StatusCategory, now = Date.now()): number | null {
  if (category === 'done') return null;
  const ageH = (now - new Date(createdAt).getTime()) / 3_600_000;
  return ageH < 24 ? 5 : ageH < 24 * 7 ? 30 : 120;
}

interface TicketRow {
  id: string;
  tenant_id: number;
  provider: string;
  external_key: string;
  external_ref: string | null;
  created_at: Date;
}

export type SyncResult = { ok: true } | { ok: false; error: string };

/** Reads one ticket from its system and saves what changed. Never throws. */
export async function syncTicket(ticketId: string | number, tenantId?: number): Promise<SyncResult> {
  const t = await queryOne<TicketRow>(
    `SELECT id, tenant_id, provider, external_key, external_ref, created_at FROM wk_tickets WHERE id = $1 AND ($2::int IS NULL OR tenant_id = $2)`,
    [ticketId, tenantId ?? null]
  );
  if (!t) return { ok: false, error: 'Ticket not found' };

  const fail = async (error: string): Promise<SyncResult> => {
    await query(`UPDATE wk_tickets SET sync_error = $2, next_sync_at = NOW() + INTERVAL '15 minutes' WHERE id = $1`, [t.id, error.slice(0, 300)]);
    return { ok: false, error };
  };

  try {
    const cfg = await loadTicketConfig(t.tenant_id);
    if (!cfg) return fail('No ticket system is set up for this organisation any more.');
    if (cfg.provider !== t.provider) return fail(`This ticket is in ${t.provider === 'jira' ? 'Jira' : 'ServiceNow'}, but the organisation now uses ${cfg.provider === 'jira' ? 'Jira' : 'ServiceNow'}.`);

    const remote = await fetchRemote(cfg, { key: t.external_key, ref: t.external_ref });
    const minutes = nextSyncMinutes(t.created_at, remote.category);

    await transaction(async (client) => {
      await client.query(
        `UPDATE wk_tickets SET status = $2, status_category = $3, assignee = $4, external_priority = $5, external_updated_at = $6,
                synced_at = NOW(), sync_error = NULL,
                next_sync_at = CASE WHEN $7::int IS NULL THEN NULL ELSE NOW() + make_interval(mins => $7::int) END
          WHERE id = $1`,
        [t.id, remote.status, remote.category, remote.assignee, remote.priority, remote.updatedAt, minutes]
      );
      for (const c of remote.comments) {
        await client.query(
          `INSERT INTO wk_ticket_comments (ticket_id, external_id, author, body, source, created_at) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (ticket_id, external_id) DO UPDATE SET body = EXCLUDED.body, author = EXCLUDED.author`,
          [t.id, c.id, c.author, c.body, c.body.startsWith(PORTAL_COMMENT_MARK) ? 'portal' : 'external', c.createdAt]
        );
      }
    });
    return { ok: true };
  } catch (e: any) {
    return fail(e instanceof TicketError ? e.message : 'Could not read the ticket');
  }
}

/** Claims the tickets due a read (so two workers never take the same one) and reads them. */
export async function sweepTickets(): Promise<number> {
  const { rows } = await query(
    `UPDATE wk_tickets SET next_sync_at = NOW() + INTERVAL '5 minutes'
      WHERE id IN (
        SELECT t.id FROM wk_tickets t JOIN wk_tenants tn ON tn.id = t.tenant_id AND tn.status = 'active' AND tn.ticket_provider IS NOT NULL
         WHERE t.next_sync_at <= NOW() ORDER BY t.next_sync_at LIMIT ${BATCH} FOR UPDATE OF t SKIP LOCKED)
      RETURNING id`
  );
  for (const r of rows as { id: string }[]) await syncTicket(r.id);
  if (rows.length) logger.info(`[Tickets] Synced ${rows.length} ticket(s)`);
  return rows.length;
}

// ---------------------------------------------------------------- what an administrator sees

export interface TicketSyncStatus {
  tracked: number;
  open: number;
  finished: number;
  failing: number;
  lastSyncedAt: string | null;
  nextSyncAt: string | null;
  recentErrors: { key: string; error: string; at: string | null }[];
}

/** How the tenant's tickets are keeping up with its ticket system. */
export async function tenantSyncStatus(tenantId: number): Promise<TicketSyncStatus> {
  const s = await queryOne<{ tracked: number; open: number; finished: number; failing: number; last: string | null; next: string | null }>(
    `SELECT COUNT(*)::int AS tracked,
            COUNT(*) FILTER (WHERE COALESCE(status_category, 'open') <> 'done')::int AS open,
            COUNT(*) FILTER (WHERE status_category = 'done')::int AS finished,
            COUNT(*) FILTER (WHERE sync_error IS NOT NULL)::int AS failing,
            MAX(synced_at) AS last, MIN(next_sync_at) FILTER (WHERE status_category IS DISTINCT FROM 'done') AS next
       FROM wk_tickets WHERE tenant_id = $1`, [tenantId]);
  const errors = await query(
    `SELECT external_key AS key, sync_error AS error, synced_at AS at FROM wk_tickets WHERE tenant_id = $1 AND sync_error IS NOT NULL ORDER BY id DESC LIMIT 5`, [tenantId]);
  return {
    tracked: s?.tracked ?? 0, open: s?.open ?? 0, finished: s?.finished ?? 0, failing: s?.failing ?? 0,
    lastSyncedAt: s?.last ? new Date(s.last).toISOString() : null, nextSyncAt: s?.next ? new Date(s.next).toISOString() : null,
    recentErrors: errors.rows as TicketSyncStatus['recentErrors'],
  };
}

/** Reads the tenant's unfinished tickets now instead of waiting for the schedule (at most 30). */
export async function syncTenantNow(tenantId: number): Promise<{ checked: number; failed: number }> {
  const { rows } = await query(
    `SELECT id FROM wk_tickets WHERE tenant_id = $1 AND COALESCE(status_category, 'open') <> 'done' ORDER BY COALESCE(synced_at, 'epoch') LIMIT 30`, [tenantId]);
  let failed = 0;
  for (const r of rows as { id: string }[]) {
    const res = await syncTicket(r.id, tenantId);
    if (!res.ok) failed++;
  }
  return { checked: rows.length, failed };
}
