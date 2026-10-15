import { v4 as uuid } from 'uuid';
import { query, queryOne } from '../db/connection.js';
import { queuePublisher } from './queues.js';
import { validateJob, dedupKey } from '../utils/workatoJob.js';
import { logger } from '../utils/logger.js';
import { classifyJob, type RecipeCfg } from './jobClassifier.js';

export const SCHEMA_VERSION = 1;

/** How an event reached us: pushed by Workato, pulled by us, or read from the drop folder. */
export type SourceMode = 'push' | 'poll' | 'file';

export interface IngestEnvelope {
  schema_version: number;
  event_id: string;
  tenant_id: number;
  source: 'workato';
  source_mode: SourceMode;
  received_at: string;
  dedup_key: string;
  job: Record<string, unknown>;
}

export interface IngestOutcome {
  accepted: number;
  /** Valid jobs that are not EDI: counted per recipe, not queued and not stored */
  ignored: number;
  quarantined: { reason: string; detail: string; retriable: boolean }[];
}

/** Finds the job list in a body: a bare job, an array, or {events|jobs: [...]}. */
export function extractJobs(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (Array.isArray(b.events)) return b.events;
    if (Array.isArray(b.jobs)) return b.jobs;
  }
  return [body];
}

async function quarantine(
  tenantId: number,
  sourceMode: SourceMode,
  reason: string,
  detail: string,
  retriable: boolean,
  payload: unknown
): Promise<void> {
  await query(
    `INSERT INTO wk_ingest_quarantine (tenant_id, reason, detail, retriable, source_mode, payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, reason, detail, retriable, sourceMode, JSON.stringify(payload ?? null)]
  );
}

/**
 * Validates, attributes and publishes job logs for one tenant.
 *
 * The tenant comes from the API key, never from the body. Anything that fails is
 * quarantined, not dropped and not published. The caller gets a count back
 * rather than a per-event error so one bad event in a batch doesn't hide the good ones.
 */
export async function ingestJobs(
  tenantId: number,
  jobs: unknown[],
  sourceMode: SourceMode = 'push'
): Promise<IngestOutcome> {
  const tenant = await queryOne<{
    status: string;
    queue_name: string;
    dlq_name: string;
    workato_account_id: string | null;
  }>(`SELECT status, queue_name, dlq_name, workato_account_id FROM wk_tenants WHERE id = $1`, [tenantId]);

  if (!tenant) throw new IngestError(404, 'Tenant not found');

  // validation_pending is accepted on purpose: the readiness test needs a sample event
  if (!['validation_pending', 'active'].includes(tenant.status)) {
    throw new IngestError(403, `Tenant is ${tenant.status}; ingestion is not accepted`);
  }

  const outcome: IngestOutcome = { accepted: 0, ignored: 0, quarantined: [] };

  // What the admin and earlier jobs have said about each recipe in this batch, fetched once
  const recipeIds = [...new Set(jobs.map((j) => (j && typeof j === 'object' ? (j as any).recipe_id : undefined)).filter((r) => r !== undefined && r !== null).map(String))];
  const cfgs = new Map<string, RecipeCfg>();
  if (recipeIds.length) {
    const { rows } = await query<RecipeCfg & { recipe_id: string }>(
      `SELECT recipe_id, ingest_mode, edi_seen_at FROM wk_recipe_configs WHERE tenant_id = $1 AND recipe_id = ANY($2)`,
      [tenantId, recipeIds]
    );
    for (const r of rows) cfgs.set(r.recipe_id, r);
  }
  const learned = new Map<string, string | null>(); // recipe -> name, to remember as EDI
  const ignored = new Map<string, { name: string | null; count: number; reason: string }>();

  for (const raw of jobs) {
    const v = validateJob(raw);
    if (!v.ok) {
      await quarantine(tenantId, sourceMode, v.reason, v.detail, v.retriable, raw);
      outcome.quarantined.push({ reason: v.reason, detail: v.detail, retriable: v.retriable });
      continue;
    }

    if (tenant.workato_account_id && String(v.job.account_id) !== tenant.workato_account_id) {
      // Never succeeds as sent, so not retriable. The id is deliberately not echoed back.
      const detail = 'Event account_id does not match this tenant';
      await quarantine(tenantId, sourceMode, 'account_mismatch', detail, false, raw);
      outcome.quarantined.push({ reason: 'account_mismatch', detail, retriable: false });
      continue;
    }

    // Not EDI: counted against the recipe so the admin can see it and overrule, but never queued or stored
    const recipeId = String(v.job.recipe_id);
    const verdict = classifyJob(v.job, cfgs.get(recipeId));
    const recipeName = typeof (v.job.context as any)?.recipe_name === 'string' ? (v.job.context as any).recipe_name : null;
    if (!verdict.keep) {
      const prior = ignored.get(recipeId);
      ignored.set(recipeId, { name: recipeName, count: (prior?.count ?? 0) + 1, reason: verdict.reason });
      outcome.ignored++;
      continue;
    }
    if (verdict.learned) learned.set(recipeId, recipeName);

    const envelope: IngestEnvelope = {
      schema_version: SCHEMA_VERSION,
      event_id: uuid(),
      tenant_id: tenantId,
      source: 'workato',
      source_mode: sourceMode,
      received_at: new Date().toISOString(),
      dedup_key: dedupKey(v.job),
      job: v.job as unknown as Record<string, unknown>,
    };

    await queuePublisher.publish(tenant.queue_name, tenant.dlq_name, envelope);
    outcome.accepted++;
  }

  // Remember recipes that showed EDI, and count what was ignored: one write per recipe, not per job
  for (const [recipeId, name] of learned) {
    await query(
      `INSERT INTO wk_recipe_configs (tenant_id, recipe_id, recipe_name, edi_seen_at) VALUES ($1,$2,$3,NOW())
       ON CONFLICT (tenant_id, recipe_id) DO UPDATE SET edi_seen_at = COALESCE(wk_recipe_configs.edi_seen_at, NOW()),
         recipe_name = COALESCE(wk_recipe_configs.recipe_name, EXCLUDED.recipe_name)`,
      [tenantId, recipeId, name]
    );
  }
  for (const [recipeId, i] of ignored) {
    await query(
      `INSERT INTO wk_recipe_configs (tenant_id, recipe_id, recipe_name, ignored_count, last_ignored_at, last_ignored_reason) VALUES ($1,$2,$3,$4,NOW(),$5)
       ON CONFLICT (tenant_id, recipe_id) DO UPDATE SET ignored_count = wk_recipe_configs.ignored_count + EXCLUDED.ignored_count,
         last_ignored_at = NOW(), last_ignored_reason = EXCLUDED.last_ignored_reason,
         recipe_name = COALESCE(wk_recipe_configs.recipe_name, EXCLUDED.recipe_name)`,
      [tenantId, recipeId, i.name, i.count, i.reason]
    );
  }

  if (outcome.quarantined.length > 0) {
    logger.warn(`[Ingest] tenant ${tenantId}: ${outcome.quarantined.length} event(s) quarantined`);
  }
  return outcome;
}

export class IngestError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
