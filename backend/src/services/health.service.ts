import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { env } from '../config/env.js';
import { query } from '../db/connection.js';
import { pingBroker } from './queues.js';
import { tenantConsumers } from './tenantConsumer.js';
import { normalizationWorker } from './normalization.worker.js';
import { rawEdiWorker } from './rawEdi.worker.js';
import { folderIngestWorker } from './folderIngest.worker.js';
import { orderfulStatusWorker } from './orderfulStatus.worker.js';
import { alertWorker } from './alert.worker.js';
import { ackRuleWorker } from './ackRule.worker.js';
import { ticketSyncWorker } from './ticketSync.worker.js';
import type { WorkerStatus } from '../utils/runStatus.js';

/**
 * Platform health for the platform admin: every moving part, whether it works, and how much work is
 * waiting. Read-only; calls no customer-facing external service and reveals no secrets, only whether
 * things are configured.
 */

export type Level = 'ok' | 'warn' | 'down';

export interface Check {
  name: string;
  level: Level;
  detail: string;
  /** Milliseconds, where a round trip was timed */
  ms?: number;
}

export interface HealthReport {
  status: Level;
  checkedAt: string;
  uptimeSeconds: number;
  node: string;
  environment: string;
  checks: Check[];
  workers: { name: string; enabled: boolean; status: WorkerStatus; level: Level; detail: string }[];
  backlog: { label: string; count: number; level: Level; hint: string }[];
  /** One row per tenant, so platform-wide numbers can be traced to who they belong to */
  tenants: { id: number; name: string; status: string; consuming: boolean; unnormalized: number; rawPending: number; rawFailed: number; lastEventAt: string | null }[];
  config: { label: string; value: string }[];
}

const dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(dirname, '../db/migrations');

const worst = (levels: Level[]): Level => (levels.includes('down') ? 'down' : levels.includes('warn') ? 'warn' : 'ok');

async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; ms: number; error?: string }> {
  const t0 = Date.now();
  try {
    return { value: await fn(), ms: Date.now() - t0 };
  } catch (e: any) {
    return { ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** A worker that should be running but is not, or whose last pass failed, is worth a look. */
export function workerLevel(enabled: boolean, s: WorkerStatus): { level: Level; detail: string } {
  if (!enabled) return { level: 'ok', detail: 'Disabled by configuration' };
  if (!s.started) return { level: 'down', detail: 'Not running' };
  if (s.lastError) return { level: 'warn', detail: `Last pass failed: ${s.lastError}` };
  if (!s.lastRunAt) return { level: 'ok', detail: 'Started, first pass pending' };
  return { level: 'ok', detail: `Last pass ${s.lastRunAt}${s.busy ? ' (running now)' : ''}` };
}

export async function collectHealth(): Promise<HealthReport> {
  const checks: Check[] = [];

  const db = await timed(() => query('SELECT 1'));
  checks.push(db.error ? { name: 'Database', level: 'down', detail: db.error, ms: db.ms } : { name: 'Database', level: db.ms > 1500 ? 'warn' : 'ok', detail: db.ms > 1500 ? 'Responding slowly' : 'Reachable', ms: db.ms });

  const broker = await pingBroker();
  checks.push(broker.ok ? { name: 'RabbitMQ', level: broker.ms > 3000 ? 'warn' : 'ok', detail: broker.ms > 3000 ? 'Responding slowly' : 'Reachable', ms: broker.ms } : { name: 'RabbitMQ', level: 'down', detail: broker.error ?? 'Unreachable', ms: broker.ms });

  let backlog: HealthReport['backlog'] = [];
  let tenants: HealthReport['tenants'] = [];
  if (!db.error) {
    const applied = await timed(async () => (await query(`SELECT filename FROM wk_schema_migrations ORDER BY filename`)).rows.map((r: any) => r.filename as string));
    const onDisk = fs.existsSync(MIGRATIONS_DIR) ? fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort() : [];
    if (applied.value) {
      const pending = onDisk.filter((f) => !applied.value!.includes(f));
      checks.push({
        name: 'Migrations',
        level: pending.length ? 'warn' : 'ok',
        detail: pending.length ? `${pending.length} not applied: ${pending.slice(0, 3).join(', ')} (run npm run db:migrate)` : `${applied.value.length} applied, latest ${applied.value.at(-1)}`,
      });
    }

    const expected = await timed(async () => Number((await query(`SELECT COUNT(*)::int AS n FROM wk_tenants WHERE status IN ('validation_pending','active')`)).rows[0].n));
    const consumers = tenantConsumers.status();
    if (expected.value !== undefined) {
      const attached = consumers.tenantIds.length;
      checks.push({
        name: 'Tenant queue consumers',
        level: !consumers.connected && expected.value > 0 ? 'down' : attached < expected.value ? 'warn' : 'ok',
        detail: `${attached} of ${expected.value} tenants being consumed${consumers.connected ? '' : ' (not connected to the broker)'}`,
      });
    }

    const perTenant = await timed(async () => (await query(
      `SELECT t.id, t.name, t.status,
              (SELECT COUNT(*)::int FROM wk_source_events e WHERE e.tenant_id = t.id AND e.normalized_at IS NULL) AS unnormalized,
              (SELECT COUNT(*)::int FROM wk_orderful_messages m WHERE m.tenant_id = t.id AND m.raw_edi_status = 'pending') AS raw_pending,
              (SELECT COUNT(*)::int FROM wk_orderful_messages m WHERE m.tenant_id = t.id AND m.raw_edi_status = 'failed') AS raw_failed,
              (SELECT MAX(e.received_at) FROM wk_source_events e WHERE e.tenant_id = t.id) AS last_event_at
         FROM wk_tenants t ORDER BY t.name`
    )).rows);
    if (perTenant.value) {
      const attached = new Set(tenantConsumers.status().tenantIds);
      tenants = (perTenant.value as any[]).map((r) => ({ id: r.id, name: r.name, status: r.status, consuming: attached.has(r.id), unnormalized: r.unnormalized, rawPending: r.raw_pending, rawFailed: r.raw_failed, lastEventAt: r.last_event_at ? new Date(r.last_event_at).toISOString() : null }));
    }

    const counts = await timed(async () => (await query(
      `SELECT
         (SELECT COUNT(*)::int FROM wk_source_events WHERE normalized_at IS NULL) AS unnormalized,
         (SELECT COUNT(*)::int FROM wk_source_events WHERE normalized_at IS NULL AND normalize_attempts >= 5) AS stuck_normalize,
         (SELECT COUNT(*)::int FROM wk_orderful_messages WHERE raw_edi_status = 'pending') AS raw_pending,
         (SELECT COUNT(*)::int FROM wk_orderful_messages WHERE raw_edi_status = 'failed') AS raw_failed,
         (SELECT COUNT(*)::int FROM wk_alert_dispatches WHERE status = 'queued') AS alerts_queued,
         (SELECT COUNT(*)::int FROM wk_alert_dispatches WHERE status IN ('failed','given_up')) AS alerts_failed,
         (SELECT COUNT(*)::int FROM wk_ingest_quarantine WHERE replayed_at IS NULL AND received_at > NOW() - INTERVAL '24 hours') AS quarantined_24h`
    )).rows[0]);
    if (counts.value) {
      const c = counts.value as Record<string, number>;
      backlog = [
        { label: 'Events awaiting normalization', count: c.unnormalized, level: c.stuck_normalize > 0 ? 'warn' : 'ok', hint: c.stuck_normalize > 0 ? `${c.stuck_normalize} keep failing and need a look` : 'Normally drains within a minute' },
        { label: 'Raw EDI waiting to convert', count: c.raw_pending, level: 'ok', hint: 'Converted by the background sweep' },
        { label: 'Raw EDI conversions failed', count: c.raw_failed, level: c.raw_failed > 0 ? 'warn' : 'ok', hint: 'Check the tenant Orderful key; admins can requeue' },
        { label: 'Alert emails queued', count: c.alerts_queued, level: c.alerts_queued > 50 ? 'warn' : 'ok', hint: 'Sent on the next alert sweep' },
        { label: 'Alert emails not delivered', count: c.alerts_failed, level: c.alerts_failed > 0 ? 'warn' : 'ok', hint: 'Usually a tenant Brevo key or sender problem' },
        { label: 'Events quarantined (24 h)', count: c.quarantined_24h, level: c.quarantined_24h > 0 ? 'warn' : 'ok', hint: 'Refused at the door: wrong account or malformed' },
      ];
    }
  }

  const defs: [string, boolean, WorkerStatus][] = [
    ['Normalization sweep', true, normalizationWorker.status()],
    ['Raw EDI conversion', env.RAW_EDI_ENABLED, rawEdiWorker.status()],
    ['Drop-folder ingest', env.INGEST_DROP_ENABLED, folderIngestWorker.status()],
    ['Orderful status checks (outbound)', env.RAW_EDI_ENABLED, orderfulStatusWorker.status()],
    ['Email alerts', env.ALERTS_ENABLED, alertWorker.status()],
    ['997 reminder rules', env.ALERTS_ENABLED, ackRuleWorker.status()],
    ['Ticket status sync', env.ALERTS_ENABLED, ticketSyncWorker.status()],
  ];
  const workers = defs.map(([name, enabled, status]) => ({ name, enabled, status, ...workerLevel(enabled, status) }));

  const host = (u: string) => {
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  };
  const config = [
    { label: 'Environment', value: env.NODE_ENV },
    { label: 'Portal URL', value: env.PORTAL_URL },
    { label: 'Public API URL (ingest, MCP)', value: env.PUBLIC_API_URL || 'not set (derived per request)' },
    { label: 'MCP server', value: env.MCP_ENABLED ? 'on' : 'off' },
    { label: 'Orderful API', value: host(env.ORDERFUL_API_URL) },
    { label: 'Brevo API', value: host(env.BREVO_API_URL) },
    { label: 'Gemini model', value: env.GEMINI_MODEL },
    { label: 'Encryption key', value: env.WK_ENCRYPTION_KEY ? 'set' : 'MISSING' },
    { label: 'Drop folder', value: env.INGEST_DROP_ENABLED ? 'on' : 'off' },
  ];

  const status = worst([...checks.map((c) => c.level), ...workers.map((w) => w.level), ...backlog.map((b) => b.level)]);
  return { status, checkedAt: new Date().toISOString(), uptimeSeconds: Math.round(process.uptime()), node: process.version, environment: env.NODE_ENV, checks, workers, backlog, tenants, config };
}
