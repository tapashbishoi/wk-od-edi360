import { queryOne } from '../db/connection.js';
import { provisionTenantQueues, inspectQueue } from './queues.js';

export type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface ReadinessCheck {
  name: string;
  status: CheckStatus;
  detail?: string;
}

export interface ReadinessResult {
  ok: boolean;
  checks: ReadinessCheck[];
}

/**
 * The PRD's readiness test, as far as this slice can run it. Declares the
 * tenant's queue and DLQ as a side effect (idempotent), because "the queue
 * exists" can only be proven by creating it.
 *
 * orderful_connectivity is reported `skipped` rather than `pass` until the
 * Orderful endpoint is verified - a skipped check never blocks activation, but
 * it must never be shown as passing something it didn't test.
 */
export async function runReadiness(tenantId: number): Promise<ReadinessResult> {
  const tenant = await queryOne<{ queue_name: string; dlq_name: string }>(
    `SELECT queue_name, dlq_name FROM wk_tenants WHERE id = $1`,
    [tenantId]
  );
  if (!tenant) throw new Error('Tenant not found');

  const checks: ReadinessCheck[] = [];

  try {
    await provisionTenantQueues(tenant.queue_name, tenant.dlq_name);
    const info = await inspectQueue(tenant.queue_name);
    checks.push(
      info.exists
        ? { name: 'queue_declared', status: 'pass', detail: tenant.queue_name }
        : { name: 'queue_declared', status: 'fail', detail: info.error ?? 'Queue not found after declaring it' }
    );
  } catch (error: any) {
    checks.push({ name: 'queue_declared', status: 'fail', detail: error.message });
  }

  const keys = await queryOne<{ n: string }>(
    `SELECT COUNT(*) AS n FROM wk_api_keys WHERE tenant_id = $1 AND is_active AND (expires_at IS NULL OR expires_at > NOW())`,
    [tenantId]
  );
  checks.push(
    Number(keys?.n) > 0
      ? { name: 'api_key_issued', status: 'pass' }
      : { name: 'api_key_issued', status: 'fail', detail: 'No active API key' }
  );

  const orderful = await queryOne(`SELECT 1 FROM wk_tenant_credentials WHERE tenant_id = $1 AND kind = 'orderful'`, [tenantId]);
  checks.push(
    orderful
      ? { name: 'orderful_credential', status: 'pass' }
      : { name: 'orderful_credential', status: 'fail', detail: 'No Orderful credential configured' }
  );

  checks.push({ name: 'orderful_connectivity', status: 'skipped', detail: 'Connectivity test not implemented yet' });

  const events = await queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM wk_source_events WHERE tenant_id = $1`, [tenantId]);
  checks.push(
    Number(events?.n) > 0
      ? { name: 'sample_event_ingested', status: 'pass', detail: `${events!.n} event(s)` }
      : { name: 'sample_event_ingested', status: 'fail', detail: 'No events ingested yet' }
  );

  return { ok: checks.every((c) => c.status !== 'fail'), checks };
}
