import { query, queryOne } from '../db/connection.js';
import { logger } from '../utils/logger.js';
import { decryptSecret } from '../utils/crypto.js';
import { getTransaction, OrderfulError } from './orderful.client.js';
import { extractOrderful, type ObservedOrderful } from './normalizeJob.js';
import { normalizeEvent } from './normalization.service.js';

/**
 * Keeps the status of transactions we SENT up to date from Orderful itself.
 *
 * An outbound Workato log only says a transaction was created; whether it was valid, delivered and
 * acknowledged is Orderful's to say: GET /v3/transactions/{id} -> validationStatus (VALID | INVALID),
 * deliveryStatus (PENDING | SENT | DELIVERED | FAILED), acknowledgmentStatus.
 *
 * Each pending transaction is asked about on a widening schedule (1 min, then 10 min, then 2 h) until its
 * outcome is final, or three days pass. When Orderful's answer changes anything, the job is normalized
 * again with the observed facts, which updates the lanes and the transaction's status.
 *
 * Deferred and per tenant (their own Orderful key); a slow or down Orderful never blocks ingestion.
 */

const MAX_AGE_DAYS = 3;
const BATCH = 50;

/** Nothing more to learn: invalid, failed, or delivered and acknowledged one way or the other. */
export function isFinal(s: { validation?: string | null; delivery?: string | null; ack?: string | null }): boolean {
  const v = s.validation?.toUpperCase();
  const d = s.delivery?.toUpperCase();
  const a = s.ack?.toUpperCase();
  return v === 'INVALID' || d === 'FAILED' || (d === 'DELIVERED' && (a === 'ACCEPTED' || a === 'REJECTED'));
}

/** Minutes until the next question: often while it is new, rarely once it has been waiting a while. */
export function nextCheckMinutes(ageMinutes: number): number {
  return ageMinutes < 15 ? 1 : ageMinutes < 120 ? 10 : 120;
}

interface Due {
  id: number;
  tenant_id: number;
  transaction_id: number;
  orderful_transaction_id: string;
  environment: string;
  status_attempts: number;
  validation_status: string | null;
  delivery_status: string | null;
  acknowledgment_status: string | null;
  age_minutes: number;
}

async function orderfulKey(tenantId: number, environment: string): Promise<string | null> {
  const row = await queryOne<{ secret_enc: string }>(
    `SELECT secret_enc FROM wk_tenant_credentials WHERE tenant_id = $1 AND kind = 'orderful'
      ORDER BY (environment = $2) DESC, (environment = 'production') DESC LIMIT 1`,
    [tenantId, environment]
  );
  try {
    return row ? decryptSecret(row.secret_enc) : null;
  } catch {
    return null;
  }
}

/** Orderful's re-enveloped control numbers belong to the receiver, not to what we sent: keep the log's. */
const OBSERVED_KEYS = [
  'typeName', 'documentType', 'businessNumber', 'senderIsaId', 'senderName', 'receiverIsaId', 'receiverName', 'stream',
  'validationStatus', 'acknowledgmentStatus', 'deliveryStatus', 'deliveryId', 'createdAt', 'lastUpdatedAt',
] as const;

export function observedFrom(raw: Record<string, any>): ObservedOrderful | null {
  const facts = extractOrderful(raw);
  if (!facts?.transactionId) return null;
  const out: Record<string, unknown> = { transactionId: facts.transactionId };
  for (const k of OBSERVED_KEYS) if (facts[k] != null) out[k] = facts[k];
  return out as unknown as ObservedOrderful;
}

/** Re-normalizes every log of this transaction so the lanes and status reflect the new facts. */
async function renormalize(transactionId: number): Promise<void> {
  const { rows } = await query<{ source_event_id: number }>(`SELECT source_event_id FROM wk_executions WHERE transaction_id = $1`, [transactionId]);
  for (const { source_event_id } of rows) {
    await query(`UPDATE wk_source_events SET normalized_at = NULL, normalize_attempts = 0, normalize_error = NULL WHERE id = $1`, [source_event_id]);
    await normalizeEvent(source_event_id);
  }
}

export type CheckResult = 'updated' | 'unchanged' | 'no_credential' | 'error';

/** Asks Orderful about one transaction and records the answer. Never throws for an expected failure. */
export async function checkOne(row: Due): Promise<{ result: CheckResult; error?: string }> {
  const key = await orderfulKey(row.tenant_id, row.environment);
  if (!key) {
    await query(`UPDATE wk_orderful_messages SET status_next_at = NOW() + INTERVAL '1 hour', status_error = 'No Orderful API key saved for this tenant' WHERE id = $1`, [row.id]);
    return { result: 'no_credential', error: 'No Orderful API key saved for this tenant' };
  }

  try {
    const observed = observedFrom(await getTransaction(key, row.orderful_transaction_id));
    if (!observed) throw new OrderfulError('invalid', 'Orderful returned something that is not a transaction');

    const changed =
      (observed.validationStatus ?? null) !== row.validation_status ||
      (observed.deliveryStatus ?? null) !== row.delivery_status ||
      (observed.acknowledgmentStatus ?? null) !== row.acknowledgment_status;
    const final = isFinal({ validation: observed.validationStatus, delivery: observed.deliveryStatus, ack: observed.acknowledgmentStatus });
    const wait = final ? null : nextCheckMinutes(row.age_minutes);

    await query(
      `UPDATE wk_orderful_messages SET
         type_name = COALESCE($2, type_name), business_number = COALESCE($3, business_number),
         sender_isa_id = COALESCE($4, sender_isa_id), sender_name = COALESCE($5, sender_name),
         receiver_isa_id = COALESCE($6, receiver_isa_id), receiver_name = COALESCE($7, receiver_name),
         stream = COALESCE($8, stream), validation_status = $9, delivery_status = $10, acknowledgment_status = $11,
         delivery_id = COALESCE($12, delivery_id), orderful_created_at = COALESCE($13, orderful_created_at), orderful_updated_at = $14,
         observed_at = NOW(), status_checked_at = NOW(), status_attempts = 0, status_error = NULL,
         status_next_at = CASE WHEN $15::int IS NULL THEN NULL ELSE NOW() + ($15::int || ' minutes')::interval END
       WHERE id = $1`,
      [
        row.id, observed.typeName ?? null, observed.businessNumber ?? null, observed.senderIsaId ?? null, observed.senderName ?? null,
        observed.receiverIsaId ?? null, observed.receiverName ?? null, observed.stream ?? null,
        observed.validationStatus ?? null, observed.deliveryStatus ?? null, observed.acknowledgmentStatus ?? null,
        observed.deliveryId ?? null, observed.createdAt ?? null, observed.lastUpdatedAt ?? null, wait,
      ]
    );
    // A transaction that is final is never asked about again; the partner names are worth keeping on it
    await query(
      `UPDATE wk_transactions SET sender_name = COALESCE($2, sender_name), receiver_name = COALESCE($3, receiver_name),
              business_number = COALESCE($4, business_number) WHERE id = $1`,
      [row.transaction_id, observed.senderName ?? null, observed.receiverName ?? null, observed.businessNumber ?? null]
    );

    // First answer, or the answer changed: the lanes and status may have too
    if (changed || row.validation_status === null) await renormalize(row.transaction_id);
    return { result: changed ? 'updated' : 'unchanged' };
  } catch (error: any) {
    const kind = error instanceof OrderfulError ? error.kind : 'transient';
    const text = String(error.message).slice(0, 300);
    const attempts = row.status_attempts + 1;
    // A bad key or an unknown id will not fix itself in minutes; a flaky network might
    const minutes = kind === 'transient' ? [2, 15, 60][Math.min(attempts - 1, 2)] : 360;
    await query(
      `UPDATE wk_orderful_messages SET status_attempts = $2, status_error = $3, status_next_at = NOW() + ($4 || ' minutes')::interval WHERE id = $1`,
      [row.id, attempts, text, String(minutes)]
    );
    logger.warn(`[OrderfulStatus] Transaction ${row.orderful_transaction_id} (${kind}): ${text}`);
    return { result: 'error', error: text };
  }
}

const SELECT_DUE = `
  m.id, m.tenant_id, m.transaction_id, m.orderful_transaction_id, t.environment, m.status_attempts,
  m.validation_status, m.delivery_status, m.acknowledgment_status,
  GREATEST(0, EXTRACT(EPOCH FROM (NOW() - COALESCE(m.orderful_created_at, m.observed_at))) / 60)::int AS age_minutes`;

/** One sweep over outbound transactions whose Orderful status is not final yet. */
export async function refreshPending(): Promise<{ checked: number; updated: number; errors: number }> {
  // Claimed in the statement that selects them (SKIP LOCKED), so two instances never ask about the same one
  const { rows } = await query<Due>(
    `WITH picked AS (
       UPDATE wk_orderful_messages m SET status_next_at = NOW() + INTERVAL '2 minutes'
        WHERE m.id IN (
          SELECT m2.id FROM wk_orderful_messages m2
            JOIN wk_transactions t2 ON t2.id = m2.transaction_id
            JOIN wk_tenants tn ON tn.id = m2.tenant_id AND tn.status IN ('validation_pending','active')
           WHERE t2.direction = 'outbound'
             AND COALESCE(m2.orderful_created_at, m2.observed_at) > NOW() - INTERVAL '${MAX_AGE_DAYS} days'
             AND (m2.status_checked_at IS NULL OR m2.status_next_at IS NOT NULL)
             AND (m2.status_next_at IS NULL OR m2.status_next_at <= NOW())
             AND EXISTS (SELECT 1 FROM wk_tenant_credentials c WHERE c.tenant_id = m2.tenant_id AND c.kind = 'orderful')
           ORDER BY m2.status_next_at NULLS FIRST, m2.id
           LIMIT ${BATCH} FOR UPDATE OF m2 SKIP LOCKED)
        RETURNING m.id)
     SELECT ${SELECT_DUE}
       FROM wk_orderful_messages m JOIN wk_transactions t ON t.id = m.transaction_id
      WHERE m.id IN (SELECT id FROM picked)`
  );

  let updated = 0;
  let errors = 0;
  for (const row of rows) {
    const { result } = await checkOne(row);
    if (result === 'updated') updated++;
    if (result === 'error' || result === 'no_credential') errors++;
  }
  return { checked: rows.length, updated, errors };
}

/** The "Refresh from Orderful" button: ask now, whatever the schedule says. */
export async function refreshTransactionNow(tenantId: number, transactionId: number): Promise<{ result: CheckResult | 'not_found' | 'not_outbound'; error?: string }> {
  const row = await queryOne<Due & { direction: string }>(
    `SELECT ${SELECT_DUE}, t.direction
       FROM wk_orderful_messages m JOIN wk_transactions t ON t.id = m.transaction_id
      WHERE m.transaction_id = $1 AND m.tenant_id = $2 LIMIT 1`,
    [transactionId, tenantId]
  );
  if (!row) return { result: 'not_found' };
  if (row.direction !== 'outbound') return { result: 'not_outbound' };
  return checkOne(row);
}
