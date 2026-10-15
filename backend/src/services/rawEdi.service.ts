import crypto from 'crypto';
import { query, queryOne } from '../db/connection.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { encryptSecret, decryptSecret } from '../utils/crypto.js';
import { convertToX12, OrderfulError, backoffMinutes } from './orderful.client.js';
import { extractOrderfulMessage } from './normalizeJob.js';
import { extractAndStore } from './businessDetails.service.js';
import type { Direction, WorkatoJob } from '../utils/workatoJob.js';

/**
 * Raw EDI enrichment: for each Orderful message, send the message JSON the log
 * already carries to POST /v3/convert and keep the X12 that comes back.
 *
 * Deferred by design - never in the ingest or consumer path. A convert call is a
 * network round trip to a third party, and ingestion must keep working when
 * Orderful is slow or down.
 *
 * - Per-tenant switch (wk_tenants.raw_edi_enabled), off by default.
 * - The tenant's own Orderful key is used, and only tenants that have one are claimed.
 * - raw_edi is stored as an encrypted envelope, never plaintext.
 * - Re-derivable: the input is in the source log, so nothing here is the only copy.
 */

interface Claimed {
  id: number;
  tenant_id: number;
  transaction_id: number;
  raw_edi_attempts: number;
  raw_edi_hash: string | null;
  raw_edi: string | null;
  environment: string;
  document_type: string | null;
  /** Business details already extracted for this transaction */
  has_details: boolean;
}

const hashOf = (message: unknown) => crypto.createHash('sha256').update(JSON.stringify(message)).digest('hex');

/** Prefers the credential matching the transaction's environment, then production, then any. */
async function orderfulKey(tenantId: number, environment: string): Promise<string | null> {
  const row = await queryOne<{ secret_enc: string }>(
    `SELECT secret_enc FROM wk_tenant_credentials
      WHERE tenant_id = $1 AND kind = 'orderful'
      ORDER BY (environment = $2) DESC, (environment = 'production') DESC
      LIMIT 1`,
    [tenantId, environment]
  );
  return row ? decryptSecret(row.secret_enc) : null;
}

/** The message JSON from the newest log of this transaction that has one. */
async function findMessage(transactionId: number): Promise<Record<string, any> | null> {
  const { rows } = await query<{ raw_job: WorkatoJob; direction: Direction }>(
    `SELECT s.raw_job, e.direction
       FROM wk_executions e JOIN wk_source_events s ON s.id = e.source_event_id
      WHERE e.transaction_id = $1
      ORDER BY e.started_at DESC, e.id DESC
      LIMIT 5`,
    [transactionId]
  );
  for (const r of rows) {
    const msg = extractOrderfulMessage(r.raw_job, r.direction);
    if (msg) return msg;
  }
  return null;
}

/** Converts one message and records the outcome. Never throws for an expected failure. */
export async function convertOne(row: Claimed): Promise<'converted' | 'failed' | 'retry' | 'unavailable' | 'skipped'> {
  const message = await findMessage(row.transaction_id);
  if (!message) {
    await query(
      `UPDATE wk_orderful_messages SET raw_edi_status = 'unavailable', raw_edi_error = 'No message JSON in the transaction logs',
              raw_edi_next_at = NULL WHERE id = $1`,
      [row.id]
    );
    return 'unavailable';
  }

  const hash = hashOf(message);
  // Same input as last time and we already hold the result: nothing to ask Orderful
  if (row.raw_edi && row.raw_edi_hash === hash) {
    await query(`UPDATE wk_orderful_messages SET raw_edi_status = 'converted', raw_edi_next_at = NULL WHERE id = $1`, [row.id]);
    // Converted earlier but never parsed (e.g. before business details existed): parse what we hold
    if (!row.has_details) {
      try {
        await extractAndStore(row.tenant_id, row.transaction_id, decryptSecret(row.raw_edi), row.document_type);
      } catch {
        /* stored under an old encryption key: it will be re-converted instead */
      }
    }
    return 'skipped';
  }

  const key = await orderfulKey(row.tenant_id, row.environment);
  if (!key) return 'skipped'; // left pending; picked up once a credential exists

  const attempts = row.raw_edi_attempts + 1;
  try {
    const edi = await convertToX12(key, message);
    await query(
      `UPDATE wk_orderful_messages SET raw_edi = $2, raw_edi_hash = $3, raw_edi_status = 'converted', raw_edi_error = NULL,
              raw_edi_attempts = $4, raw_edi_next_at = NULL, raw_edi_converted_at = NOW() WHERE id = $1`,
      [row.id, encryptSecret(edi), hash, attempts]
    );
    // The business card (ship from/to, amounts, references) comes from the same X12.
    // A parse problem is logged inside and never undoes the conversion.
    await extractAndStore(row.tenant_id, row.transaction_id, edi, row.document_type);
    return 'converted';
  } catch (error: any) {
    const kind = error instanceof OrderfulError ? error.kind : 'transient';
    const text = String(error.message).slice(0, 300);
    const wait = kind === 'transient' ? backoffMinutes(attempts) : null;

    if (wait != null) {
      await query(
        `UPDATE wk_orderful_messages SET raw_edi_attempts = $2, raw_edi_error = $3,
                raw_edi_next_at = NOW() + ($4 || ' minutes')::interval WHERE id = $1`,
        [row.id, attempts, text, String(wait)]
      );
      return 'retry';
    }
    await query(
      `UPDATE wk_orderful_messages SET raw_edi_status = 'failed', raw_edi_attempts = $2, raw_edi_error = $3, raw_edi_next_at = NULL WHERE id = $1`,
      [row.id, attempts, text]
    );
    logger.warn(`[RawEDI] Message ${row.id} failed (${kind}): ${text}`);
    return 'failed';
  }
}

/**
 * One sweep. Claims up to RAW_EDI_PER_TENANT_BATCH per tenant, so a tenant with
 * a large backlog can't starve the rest, and runs a few conversions at once.
 */
export async function convertPending(): Promise<{ converted: number; failed: number; retry: number }> {
  // Claimed inside one statement with SKIP LOCKED, so two instances never convert the same row
  const { rows } = await query<Claimed>(
    `WITH ranked AS (
       SELECT m.id,
              ROW_NUMBER() OVER (PARTITION BY m.tenant_id ORDER BY m.observed_at) AS rn
         FROM wk_orderful_messages m
         JOIN wk_tenants t ON t.id = m.tenant_id AND t.raw_edi_enabled AND t.status IN ('validation_pending','active')
        WHERE m.raw_edi_status = 'pending'
          AND (m.raw_edi_next_at IS NULL OR m.raw_edi_next_at <= NOW())
          AND EXISTS (SELECT 1 FROM wk_tenant_credentials c WHERE c.tenant_id = m.tenant_id AND c.kind = 'orderful')
     ), picked AS (
       SELECT m.id FROM wk_orderful_messages m JOIN ranked r ON r.id = m.id
        WHERE r.rn <= $1
          FOR UPDATE OF m SKIP LOCKED
     )
     SELECT m.id, m.tenant_id, m.transaction_id, m.raw_edi_attempts, m.raw_edi_hash, m.raw_edi,
            COALESCE(NULLIF(x.environment, 'unknown'), 'production') AS environment,
            x.document_type, (x.details_source = 'edi') AS has_details
       FROM wk_orderful_messages m
       JOIN picked p ON p.id = m.id
       JOIN wk_transactions x ON x.id = m.transaction_id`,
    [env.RAW_EDI_PER_TENANT_BATCH]
  );

  const tally = { converted: 0, failed: 0, retry: 0 };
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next++];
      try {
        const r = await convertOne(row);
        if (r === 'converted') tally.converted++;
        else if (r === 'failed') tally.failed++;
        else if (r === 'retry') tally.retry++;
      } catch (error: any) {
        logger.error(`[RawEDI] Message ${row.id}: ${error.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, env.RAW_EDI_CONCURRENCY) }, worker));
  return tally;
}

/**
 * Re-queues failed messages after the tenant replaces its Orderful key, since an
 * auth failure can't succeed again until the credential changes.
 */
export async function requeueFailed(tenantId: number): Promise<number> {
  const r = await query(
    `UPDATE wk_orderful_messages SET raw_edi_status = 'pending', raw_edi_attempts = 0, raw_edi_error = NULL, raw_edi_next_at = NULL
      WHERE tenant_id = $1 AND raw_edi_status = 'failed'`,
    [tenantId]
  );
  return r.rowCount;
}

/** Decrypts a stored message's raw EDI. Caller is responsible for the permission check and audit. */
export function readRawEdi(envelope: string): string {
  return decryptSecret(envelope);
}

/** Converts one transaction's message immediately (support tooling / testing). Requires the tenant switch. */
export async function convertNow(
  tenantId: number,
  transactionId: number
): Promise<{ result: Awaited<ReturnType<typeof convertOne>> | 'not_found' | 'disabled' | 'no_credential'; error?: string | null }> {
  const tenant = await queryOne<{ raw_edi_enabled: boolean }>(`SELECT raw_edi_enabled FROM wk_tenants WHERE id = $1`, [tenantId]);
  if (!tenant?.raw_edi_enabled) return { result: 'disabled' };

  const row = await queryOne<Claimed>(
    `SELECT m.id, m.tenant_id, m.transaction_id, 0 AS raw_edi_attempts, m.raw_edi_hash, m.raw_edi,
            COALESCE(NULLIF(x.environment, 'unknown'), 'production') AS environment,
            x.document_type, (x.details_source = 'edi') AS has_details
       FROM wk_orderful_messages m JOIN wk_transactions x ON x.id = m.transaction_id
      WHERE m.transaction_id = $1 AND m.tenant_id = $2`,
    [transactionId, tenantId]
  );
  if (!row) return { result: 'not_found' };
  if (!(await orderfulKey(tenantId, row.environment))) return { result: 'no_credential' };

  const result = await convertOne(row);
  const after = await queryOne<{ raw_edi_error: string | null }>(`SELECT raw_edi_error FROM wk_orderful_messages WHERE id = $1`, [row.id]);
  return { result, error: after?.raw_edi_error };
}
