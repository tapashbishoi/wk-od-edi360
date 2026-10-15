import { query, queryOne, transaction } from '../db/connection.js';
import { logger } from '../utils/logger.js';
import { normalizeJob, extractOrderfulMessage, NormalizedExecution, type ObservedOrderful } from './normalizeJob.js';
import { extractBusinessFromMessage } from './orderfulJsonDetails.js';
import { applyBusinessColumns } from './businessDetails.service.js';
import type { WorkatoJob } from '../utils/workatoJob.js';

/**
 * Persists a normalized job: the transaction, its Orderful message, the
 * execution, and the three stage rows. All writes for one event share one
 * database transaction, and normalized_at is set last, so an event is either
 * fully normalized or untouched and retried.
 *
 * Idempotent: re-running an event (a recipe config change, a fixed rule)
 * updates the same execution and stage rows rather than adding more.
 */

/** Stops a poison event from being retried forever by the sweep. */
export const MAX_NORMALIZE_ATTEMPTS = 5;

interface EventRow {
  id: number;
  tenant_id: number;
  raw_job: WorkatoJob;
}

async function loadOverride(tenantId: number, recipeId: string) {
  const cfg = await queryOne<{ direction: string | null; document_type: string | null }>(
    `SELECT direction, document_type FROM wk_recipe_configs WHERE tenant_id = $1 AND recipe_id = $2 AND is_active`,
    [tenantId, recipeId]
  );
  return { direction: (cfg?.direction as 'inbound' | 'outbound' | null) ?? null, documentType: cfg?.document_type ?? null };
}

/**
 * What Orderful itself reported about a transaction we sent (GET /v3/transactions/{id}, stored by the
 * status sweep). Only counted once Orderful has actually answered; before that the row holds just the log.
 */
async function loadObserved(tenantId: number, orderfulTransactionId: string): Promise<ObservedOrderful | null> {
  const m = await queryOne<any>(
    `SELECT type_name, document_type, business_number, sender_isa_id, sender_name, receiver_isa_id, receiver_name, stream,
            validation_status, acknowledgment_status, delivery_status, delivery_id, orderful_created_at, orderful_updated_at
       FROM wk_orderful_messages WHERE tenant_id = $1 AND orderful_transaction_id = $2 AND status_checked_at IS NOT NULL`,
    [tenantId, orderfulTransactionId]
  );
  if (!m) return null;
  const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
  return {
    transactionId: orderfulTransactionId,
    typeName: m.type_name, documentType: m.document_type, businessNumber: m.business_number,
    senderIsaId: m.sender_isa_id, senderName: m.sender_name, receiverIsaId: m.receiver_isa_id, receiverName: m.receiver_name,
    stream: m.stream, validationStatus: m.validation_status, acknowledgmentStatus: m.acknowledgment_status,
    deliveryStatus: m.delivery_status, deliveryId: m.delivery_id, createdAt: iso(m.orderful_created_at), lastUpdatedAt: iso(m.orderful_updated_at),
  };
}

/**
 * The transaction's own fields come from its most recent execution, with older
 * ones filling gaps. Recomputed from the executions rather than patched
 * incrementally so a late, out-of-order log can never leave it stale.
 */
async function recomputeTransaction(client: any, transactionId: number): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT e.canonical_status, e.failure_stage, e.started_at, e.completed_at
       FROM wk_executions e WHERE e.transaction_id = $1
      ORDER BY e.started_at DESC, e.id DESC`,
    [transactionId]
  );
  if (rows.length === 0) return false;

  const latest = rows[0];
  await client.query(
    `UPDATE wk_transactions SET
       canonical_status = $2,
       failure_stage = $3,
       execution_count = $4,
       first_seen_at = $5,
       last_activity_at = $6,
       completed_at = $7
     WHERE id = $1`,
    [
      transactionId,
      latest.canonical_status,
      latest.failure_stage,
      rows.length,
      rows[rows.length - 1].started_at,
      latest.completed_at ?? latest.started_at,
      latest.completed_at,
    ]
  );
  return true;
}

async function persist(client: any, ev: EventRow, n: NormalizedExecution): Promise<void> {
  const o = n.orderful;

  // --- transaction (upsert on correlation key; later non-null facts fill gaps, never blank a known value)
  const txn = (
    await client.query(
      `INSERT INTO wk_transactions
         (tenant_id, correlation_key, direction, document_type, business_number, environment,
          sender_id, sender_name, receiver_id, receiver_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (tenant_id, correlation_key) DO UPDATE SET
         direction       = CASE WHEN EXCLUDED.direction IN ('inbound','outbound') THEN EXCLUDED.direction ELSE wk_transactions.direction END,
         document_type   = COALESCE(EXCLUDED.document_type, wk_transactions.document_type),
         business_number = COALESCE(EXCLUDED.business_number, wk_transactions.business_number),
         environment     = CASE WHEN EXCLUDED.environment <> 'unknown' THEN EXCLUDED.environment ELSE wk_transactions.environment END,
         sender_id       = COALESCE(EXCLUDED.sender_id, wk_transactions.sender_id),
         sender_name     = COALESCE(EXCLUDED.sender_name, wk_transactions.sender_name),
         receiver_id     = COALESCE(EXCLUDED.receiver_id, wk_transactions.receiver_id),
         receiver_name   = COALESCE(EXCLUDED.receiver_name, wk_transactions.receiver_name)
       RETURNING id`,
      [
        ev.tenant_id, n.correlationKey, n.direction, n.documentType, n.businessNumber, n.environment,
        o?.senderIsaId ?? null, o?.senderName ?? null, o?.receiverIsaId ?? null, o?.receiverName ?? null,
      ]
    )
  ).rows[0].id as number;

  // --- the execution, possibly moving between transactions on a re-normalize
  const prior = (await client.query(`SELECT transaction_id FROM wk_executions WHERE source_event_id = $1`, [ev.id])).rows[0];

  const exec = (
    await client.query(
      `INSERT INTO wk_executions
         (tenant_id, transaction_id, source_event_id, recipe_id, recipe_name, job_id, parent_job_id, master_job_id, job_url,
          direction, source_status, canonical_status, failure_stage, failure_step, failure_message,
          started_at, completed_at, duration_ms, steps, erp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (source_event_id) DO UPDATE SET
         transaction_id = EXCLUDED.transaction_id, recipe_name = EXCLUDED.recipe_name,
         direction = EXCLUDED.direction, source_status = EXCLUDED.source_status,
         canonical_status = EXCLUDED.canonical_status, failure_stage = EXCLUDED.failure_stage,
         failure_step = EXCLUDED.failure_step, failure_message = EXCLUDED.failure_message,
         completed_at = EXCLUDED.completed_at, duration_ms = EXCLUDED.duration_ms,
         steps = EXCLUDED.steps, erp = EXCLUDED.erp
       RETURNING id`,
      [
        ev.tenant_id, txn, ev.id, n.recipe.id, n.recipe.name, n.job.id, n.job.parentJobId, n.job.masterJobId, n.job.url,
        n.direction, n.job.sourceStatus, n.canonicalStatus, n.failure?.stage ?? null, n.failure?.stepNumber ?? null,
        n.failure?.message ?? null, n.job.startedAt, n.job.completedAt, n.job.durationMs,
        JSON.stringify(n.steps), n.erp ? JSON.stringify(n.erp) : null,
      ]
    )
  ).rows[0].id as number;

  // --- business details from the log itself: the Orderful message JSON that Workato already carries.
  // Immediate (no Orderful call), works for a failed job, and never overwrites what converted X12 established.
  const message = extractOrderfulMessage(ev.raw_job, n.direction);
  const fromLog = message ? extractBusinessFromMessage(message, n.documentType) : null;
  if (fromLog) await applyBusinessColumns(ev.tenant_id, txn, fromLog, 'log', (sql, params) => client.query(sql, params));

  // --- stages
  for (const s of n.stages) {
    await client.query(
      `INSERT INTO wk_transaction_stages
         (tenant_id, transaction_id, execution_id, stage_type, canonical_status, source_status, started_at, ended_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (execution_id, stage_type) DO UPDATE SET
         transaction_id = EXCLUDED.transaction_id, canonical_status = EXCLUDED.canonical_status,
         source_status = EXCLUDED.source_status, started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at`,
      [ev.tenant_id, txn, exec, s.type, s.canonicalStatus, s.sourceStatus, s.startedAt, s.endedAt]
    );
  }

  // --- Orderful message: latest observation wins, so a delayed older log can't regress newer state
  if (o?.transactionId) {
    await client.query(
      `INSERT INTO wk_orderful_messages
         (tenant_id, transaction_id, orderful_transaction_id, type_name, document_type, business_number,
          sender_isa_id, sender_name, receiver_isa_id, receiver_name, stream, validation_status,
          acknowledgment_status, delivery_status, delivery_id, isa_control_number, gs_control_number,
          st_control_number, orderful_created_at, orderful_updated_at, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (tenant_id, orderful_transaction_id) DO UPDATE SET
         transaction_id = EXCLUDED.transaction_id,
         type_name = COALESCE(EXCLUDED.type_name, wk_orderful_messages.type_name),
         document_type = COALESCE(EXCLUDED.document_type, wk_orderful_messages.document_type),
         business_number = COALESCE(EXCLUDED.business_number, wk_orderful_messages.business_number),
         sender_isa_id = COALESCE(EXCLUDED.sender_isa_id, wk_orderful_messages.sender_isa_id),
         sender_name = COALESCE(EXCLUDED.sender_name, wk_orderful_messages.sender_name),
         receiver_isa_id = COALESCE(EXCLUDED.receiver_isa_id, wk_orderful_messages.receiver_isa_id),
         receiver_name = COALESCE(EXCLUDED.receiver_name, wk_orderful_messages.receiver_name),
         stream = COALESCE(EXCLUDED.stream, wk_orderful_messages.stream),
         validation_status = EXCLUDED.validation_status,
         acknowledgment_status = EXCLUDED.acknowledgment_status,
         delivery_status = EXCLUDED.delivery_status,
         delivery_id = COALESCE(EXCLUDED.delivery_id, wk_orderful_messages.delivery_id),
         isa_control_number = COALESCE(EXCLUDED.isa_control_number, wk_orderful_messages.isa_control_number),
         gs_control_number = COALESCE(EXCLUDED.gs_control_number, wk_orderful_messages.gs_control_number),
         st_control_number = COALESCE(EXCLUDED.st_control_number, wk_orderful_messages.st_control_number),
         orderful_created_at = COALESCE(EXCLUDED.orderful_created_at, wk_orderful_messages.orderful_created_at),
         orderful_updated_at = EXCLUDED.orderful_updated_at,
         observed_at = EXCLUDED.observed_at
       WHERE wk_orderful_messages.observed_at <= EXCLUDED.observed_at`,
      [
        ev.tenant_id, txn, o.transactionId, o.typeName, o.documentType, o.businessNumber,
        o.senderIsaId, o.senderName, o.receiverIsaId, o.receiverName, o.stream, o.validationStatus,
        o.acknowledgmentStatus, o.deliveryStatus, o.deliveryId, o.isaControlNumber, o.gsControlNumber,
        o.stControlNumber, o.createdAt, o.lastUpdatedAt, n.job.startedAt,
      ]
    );
  }

  await recomputeTransaction(client, txn);

  // The execution moved to another transaction: refresh the old one, and drop it if now empty
  if (prior && prior.transaction_id !== txn) {
    await client.query(`UPDATE wk_transaction_stages SET transaction_id = $2 WHERE execution_id = $1`, [exec, txn]);
    if (!(await recomputeTransaction(client, prior.transaction_id))) {
      await client.query(`DELETE FROM wk_transactions WHERE id = $1`, [prior.transaction_id]);
    }
  }

  // Discovered recipes show up for the admin to configure; overrides are never touched here
  await client.query(
    `INSERT INTO wk_recipe_configs (tenant_id, recipe_id, recipe_name) VALUES ($1,$2,$3)
     ON CONFLICT (tenant_id, recipe_id) DO UPDATE SET recipe_name = COALESCE(EXCLUDED.recipe_name, wk_recipe_configs.recipe_name)`,
    [ev.tenant_id, n.recipe.id, n.recipe.name]
  );

  await client.query(`UPDATE wk_source_events SET normalized_at = NOW(), normalize_error = NULL WHERE id = $1`, [ev.id]);
}

/** Normalizes one stored event. Returns false when it was already normalized or locked by another worker. */
export async function normalizeEvent(eventId: number): Promise<boolean> {
  const ev = await queryOne<EventRow>(`SELECT id, tenant_id, raw_job FROM wk_source_events WHERE id = $1`, [eventId]);
  if (!ev) return false;

  try {
    // Inside the try so a rule that throws counts as an attempt and is eventually given up on
    const override = await loadOverride(ev.tenant_id, String(ev.raw_job.recipe_id));
    let normalized = normalizeJob(ev.raw_job, override);
    // A transaction we sent: fold in what Orderful has since told us about it
    if (normalized.direction === 'outbound' && normalized.orderful?.transactionId) {
      const observed = await loadObserved(ev.tenant_id, normalized.orderful.transactionId);
      if (observed) normalized = normalizeJob(ev.raw_job, override, observed);
    }

    await transaction(async (client) => {
      // Re-check under lock: two workers (consumer inline + sweep) can race on the same event
      const locked = (
        await client.query(
          `SELECT id FROM wk_source_events WHERE id = $1 AND normalized_at IS NULL FOR UPDATE SKIP LOCKED`,
          [eventId]
        )
      ).rows[0];
      if (!locked) throw new AlreadyHandled();
      await persist(client, ev, normalized);
    });
    return true;
  } catch (error: any) {
    if (error instanceof AlreadyHandled) return false;
    await query(
      `UPDATE wk_source_events SET normalize_attempts = normalize_attempts + 1, normalize_error = $2 WHERE id = $1`,
      [eventId, String(error.message).slice(0, 500)]
    );
    throw error;
  }
}

class AlreadyHandled extends Error {}

/** Sweeps events that were stored but not normalized (a crash between steps, or a re-normalize request). */
export async function normalizePending(limit = 100): Promise<{ done: number; failed: number }> {
  const { rows } = await query<{ id: number }>(
    `SELECT id FROM wk_source_events
      WHERE normalized_at IS NULL AND normalize_attempts < $2
      ORDER BY id LIMIT $1`,
    [limit, MAX_NORMALIZE_ATTEMPTS]
  );

  let done = 0;
  let failed = 0;
  for (const { id } of rows) {
    try {
      if (await normalizeEvent(id)) done++;
    } catch (error: any) {
      failed++;
      logger.error(`[Normalize] Event ${id} failed: ${error.message}`);
    }
  }
  return { done, failed };
}

/** Marks events for re-normalization, e.g. after a recipe override changes. */
export async function requestRenormalize(tenantId: number, recipeId?: string): Promise<number> {
  const result = await query(
    `UPDATE wk_source_events SET normalized_at = NULL, normalize_attempts = 0, normalize_error = NULL
      WHERE tenant_id = $1 AND ($2::text IS NULL OR recipe_id = $2)`,
    [tenantId, recipeId ?? null]
  );
  return result.rowCount;
}
