import { Router } from 'express';
import { query, queryOne } from '../db/connection.js';
import { authMiddleware, requireTenantAccess, requireTenantMember, requireActiveTenant } from '../middleware/auth.middleware.js';
import { env } from '../config/env.js';
import { audit } from '../services/audit.service.js';
import { csvCell } from '../utils/csv.js';
import { mainNumber } from '../utils/docNumber.js';
import { requestRenormalize, normalizePending } from '../services/normalization.service.js';
import { ExplainError, LANGUAGES, allowExplainRequest, explainEdi, hashEdi } from '../services/explain.service.js';
import { recordActivity } from '../services/activity.service.js';
import { costOf } from '../services/chat/pricing.js';
import { PARTNER_ID_SQL, parseViewParam, viewWhere } from '../utils/savedView.js';
import { refreshTransactionNow } from '../services/orderfulStatus.service.js';
import { readRawEdi, convertNow } from '../services/rawEdi.service.js';

/**
 * Tenant-scoped read API (dashboard, search, detail) and recipe configuration.
 * Mounted at /api/tenants/:tenantId. Every query is filtered by the tenant in
 * the path, which requireTenantMember has already checked against the caller.
 *
 * Nothing here returns payload bodies: steps are metadata only, and raw EDI
 * will arrive behind its own permission check.
 */
const router = Router({ mergeParams: true });
router.use(authMiddleware, requireActiveTenant);

const STATUSES = ['Received','In Progress','Transformed','Sent to ERP','ERP Acknowledged','Sent to Orderful','Delivered','Completed','Warning','Failed','Retrying','Unknown'];

/** Platform-owner access to customer data must be explicit and audited. */
async function auditPlatformRead(req: any, action: string, target?: string) {
  if (req.user?.role === 'platform_admin') await audit(req, { action, tenantId: Number(req.params.tenantId), target });
}

interface Filters {
  where: string;
  params: any[];
}

/** Shared by the list and the summary so dashboard totals reconcile with the list for the same filters. */
function buildFilters(tenantId: number, q: Record<string, any>): Filters | { error: string } {
  const params: any[] = [tenantId];
  const where = ['t.tenant_id = $1'];
  const add = (sql: string, v: any) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };

  if (q.status) {
    // One status, or several comma-separated (the dashboard asks for "Failed,Warning")
    const wanted = String(q.status).split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = wanted.find((s) => !STATUSES.includes(s));
    if (unknown) return { error: `Unknown status "${unknown}"` };
    add('t.canonical_status = ANY(?)', wanted);
  }
  if (q.direction) {
    if (!['inbound', 'outbound', 'ambiguous', 'unknown'].includes(q.direction)) return { error: 'Unknown direction' };
    add('t.direction = ?', q.direction);
  }
  if (q.environment) {
    if (!['test', 'production', 'unknown'].includes(q.environment)) return { error: 'Unknown environment' };
    add('t.environment = ?', q.environment);
  }
  if (q.view) {
    // The caller's My View: ISA1:850,860|ISA2. A filter on what is shown, not on what may be read.
    const clause = viewWhere(parseViewParam(q.view), params);
    if (clause) where.push(clause);
  }
  if (q.documentType) add('t.document_type = ?', String(q.documentType));
  if (q.recipeId) add('EXISTS (SELECT 1 FROM wk_executions e WHERE e.transaction_id = t.id AND e.recipe_id = ?)', String(q.recipeId));
  if (q.partner) {
    // Substring match on partner name (LIKE wildcards in the input are escaped), exact on ISA id
    params.push(`%${String(q.partner).replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const like = `$${params.length}`;
    params.push(String(q.partner));
    const exact = `$${params.length}`;
    where.push(`(t.sender_name ILIKE ${like} OR t.receiver_name ILIKE ${like} OR t.sender_id = ${exact} OR t.receiver_id = ${exact})`);
  }

  for (const [key, op] of [['from', '>='], ['to', '<=']] as const) {
    if (q[key]) {
      if (Number.isNaN(Date.parse(q[key]))) return { error: `"${key}" must be an ISO date` };
      add(`t.last_activity_at ${op} ?`, q[key]);
    }
  }

  if (q.ids) {
    // A hand-picked set of rows (the selection bar's export). Anything that isn't a plain integer is refused.
    const ids = String(q.ids).split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0 || ids.length > 500 || ids.some((s) => !/^\d{1,18}$/.test(s))) return { error: 'ids must be up to 500 numeric ids' };
    add('t.id = ANY(?::bigint[])', ids);
  }

  if (q.q) {
    // Exact identifier match: PO, shipment, invoice, BOL, Orderful id, ISA/GS control number, delivery id, any Workato job id
    params.push(String(q.q).trim());
    const p = `$${params.length}`;
    where.push(`(
      upper(t.business_number) = upper(${p})
      OR upper(t.po_number) = upper(${p}) OR upper(t.shipment_number) = upper(${p})
      OR upper(t.invoice_number) = upper(${p}) OR upper(t.bol_number) = upper(${p})
      OR EXISTS (SELECT 1 FROM wk_orderful_messages m WHERE m.transaction_id = t.id
                  AND (m.orderful_transaction_id = ${p} OR m.isa_control_number = ${p} OR m.gs_control_number = ${p} OR m.delivery_id = ${p}))
      OR EXISTS (SELECT 1 FROM wk_executions e WHERE e.transaction_id = t.id
                  AND (e.job_id = ${p} OR e.parent_job_id = ${p} OR e.master_job_id = ${p}))
    )`);
  }

  return { where: where.join(' AND '), params };
}

// ---------------------------------------------------------------- summary

router.get('/summary', requireTenantMember, async (req, res) => {
  const f = buildFilters(Number(req.params.tenantId), { ...req.query, status: undefined });
  if ('error' in f) return res.status(400).json({ error: f.error });

  const { rows } = await query(
    `SELECT t.canonical_status AS status, COUNT(*)::int AS count FROM wk_transactions t WHERE ${f.where} GROUP BY 1`,
    f.params
  );
  const byStatus = Object.fromEntries(rows.map((r: any) => [r.status, r.count]));
  const total = rows.reduce((sum: number, r: any) => sum + r.count, 0);

  await auditPlatformRead(req, 'transactions.summary');
  res.json({ total, byStatus });
});

// ---------------------------------------------------------------- trend

const DONE = `'Completed','Delivered','Sent to ERP','ERP Acknowledged','Sent to Orderful'`;

/** Transactions per day over the last N days, bucketed in the tenant's own time zone. */
router.get('/trend', requireTenantMember, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const days = Math.min(Math.max(parseInt(String(req.query.days ?? '14')) || 14, 1), 90);

  const tenant = await queryOne<{ timezone: string }>(`SELECT timezone FROM wk_tenants WHERE id = $1`, [tenantId]);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const since = new Date(Date.now() - days * 86400000).toISOString();
  const f = buildFilters(tenantId, { ...req.query, status: undefined, from: req.query.from ?? since });
  if ('error' in f) return res.status(400).json({ error: f.error });

  // A zone the database does not know falls back to UTC rather than failing the dashboard
  let tz = tenant.timezone;
  if (!(await queryOne(`SELECT 1 FROM pg_timezone_names WHERE name = $1`, [tz]))) tz = 'UTC';

  f.params.push(tz);
  const { rows } = await query(
    `SELECT to_char((t.last_activity_at AT TIME ZONE $${f.params.length})::date, 'YYYY-MM-DD') AS day,
            COUNT(*) FILTER (WHERE t.canonical_status IN (${DONE}))::int AS completed,
            COUNT(*) FILTER (WHERE t.canonical_status = 'Warning')::int AS warning,
            COUNT(*) FILTER (WHERE t.canonical_status = 'Failed')::int AS failed,
            COUNT(*) FILTER (WHERE t.canonical_status NOT IN (${DONE},'Warning','Failed'))::int AS other
       FROM wk_transactions t WHERE ${f.where} AND t.last_activity_at IS NOT NULL
      GROUP BY 1 ORDER BY 1`,
    f.params
  );

  // Gap days come back as zeros so the chart has a continuous axis
  const byDay = new Map(rows.map((r: any) => [r.day, r]));
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = fmt.format(new Date(Date.now() - i * 86400000));
    out.push(byDay.get(day) ?? { day, completed: 0, warning: 0, failed: 0, other: 0 });
  }

  await auditPlatformRead(req, 'transactions.trend');
  res.json({ timezone: tz, days: out });
});

// ---------------------------------------------------------------- list

/**
 * What a list row carries: identity and status, the business facts an analyst scans
 * (who ships to whom, amount, reference numbers), the Orderful acknowledgment, and
 * the three lane statuses. Shared by the list and the CSV export so they cannot drift.
 */
const LIST_COLUMNS = `t.id, t.direction, t.document_type, t.business_number, t.environment, t.sender_name, t.receiver_name,
              t.canonical_status, t.failure_stage, t.execution_count, t.first_seen_at, t.last_activity_at,
              t.primary_label, t.po_number, t.shipment_number, t.invoice_number, t.bol_number,
              t.ship_from, t.ship_to, t.sold_to, t.total_amount, t.currency, t.document_date,
              -- Is this partner's 997 tracked in this direction? (Partners page; on unless switched off)
              (SELECT CASE t.direction WHEN 'inbound' THEN COALESCE(ps.track_inbound_ack, TRUE) ELSE COALESCE(ps.expect_outbound_ack, TRUE) END
                 FROM (SELECT 1) one LEFT JOIN wk_partner_settings ps ON ps.tenant_id = t.tenant_id AND ps.partner_id = (${PARTNER_ID_SQL})) AS ack_tracked,
              (SELECT m.orderful_transaction_id FROM wk_orderful_messages m WHERE m.transaction_id = t.id LIMIT 1) AS orderful_transaction_id,
              (SELECT json_build_object('ack', m.acknowledgment_status, 'delivery', m.delivery_status, 'validation', m.validation_status,
                                       'isa', m.isa_control_number)
                 FROM wk_orderful_messages m WHERE m.transaction_id = t.id LIMIT 1) AS orderful,
              -- Lane statuses of the latest execution, e.g. {"orderful":"Delivered","workato":"Warning","erp":"Sent to ERP"}
              (SELECT json_object_agg(s.stage_type, s.canonical_status) FROM wk_transaction_stages s
                WHERE s.execution_id = (SELECT e.id FROM wk_executions e WHERE e.transaction_id = t.id
                                         ORDER BY e.started_at DESC, e.id DESC LIMIT 1)) AS stages`;

router.get('/transactions', requireTenantMember, async (req, res) => {
  const f = buildFilters(Number(req.params.tenantId), req.query);
  if ('error' in f) return res.status(400).json({ error: f.error });

  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50')) || 50, 1), 200);
  const offset = Math.max(parseInt(String(req.query.offset ?? '0')) || 0, 0);

  const [list, count] = await Promise.all([
    query(
      `SELECT ${LIST_COLUMNS}
         FROM wk_transactions t WHERE ${f.where}
        ORDER BY t.last_activity_at DESC NULLS LAST, t.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      f.params
    ),
    queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM wk_transactions t WHERE ${f.where}`, f.params),
  ]);

  await auditPlatformRead(req, 'transactions.list');
  res.json({ transactions: list.rows, total: count?.n ?? 0, limit, offset });
});

// ---------------------------------------------------------------- CSV export

const EXPORT_LIMIT = 5000;

/**
 * Same filters as the list (including the selection bar's `ids`), capped. Business facts and
 * identifiers only: never raw EDI, never anything from a credential. Each export is audited.
 * Declared before /transactions/:id so "export" is not read as an id.
 */
router.get('/export/transactions.csv', requireTenantMember, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const f = buildFilters(tenantId, req.query);
  if ('error' in f) return res.status(400).json({ error: f.error });

  const { rows } = await query(
    `SELECT ${LIST_COLUMNS} FROM wk_transactions t WHERE ${f.where}
      ORDER BY t.last_activity_at DESC NULLS LAST, t.id DESC LIMIT ${EXPORT_LIMIT}`,
    f.params
  );

  const header = [
    'Status', 'Document type', 'Document number', 'Direction', 'Sender', 'Receiver', 'Ship from', 'Ship to', 'Sold to',
    'Amount', 'Currency', 'Document date', 'PO', 'Shipment', 'Invoice', 'BOL', 'Orderful ID', 'Acknowledgment', 'Delivery',
    'Environment', 'Runs', 'Last activity',
  ];
  const lines = rows.map((r: any) =>
    [
      r.canonical_status, r.document_type, mainNumber(r), r.direction,
      r.sender_name, r.receiver_name, r.ship_from, r.ship_to, r.sold_to, r.total_amount, r.currency, r.document_date,
      r.po_number, r.shipment_number, r.invoice_number, r.bol_number, r.orderful_transaction_id, r.orderful?.ack, r.orderful?.delivery,
      r.environment, r.execution_count, r.last_activity_at,
    ].map(csvCell).join(',')
  );

  await audit(req, { action: 'transactions.export', tenantId, details: { rows: rows.length, capped: rows.length === EXPORT_LIMIT } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="transactions-${new Date().toISOString().slice(0, 10)}.csv"`);
  // A UTF-8 BOM so Excel reads accented partner names correctly
  res.send('﻿' + [header.join(','), ...lines].join('\r\n') + '\r\n');
});

// ---------------------------------------------------------------- detail

const LANE_LABELS = {
  orderful: 'Orderful',
  workato: 'Workato',
  erp_destination: 'Target (ERP)',
  erp_origin: 'Source (ERP)',
} as const;

router.get('/transactions/:id', requireTenantMember, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid transaction id' });

  const txn = await queryOne(`SELECT * FROM wk_transactions WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });

  const [message, executions, stages] = await Promise.all([
    // raw_edi deliberately excluded: payload access gets its own permission check
    queryOne(
      `SELECT orderful_transaction_id, type_name, document_type, business_number, sender_isa_id, sender_name,
              receiver_isa_id, receiver_name, stream, validation_status, acknowledgment_status, delivery_status,
              delivery_id, isa_control_number, gs_control_number, st_control_number,
              orderful_created_at, orderful_updated_at, raw_edi_status, status_checked_at, status_error
         FROM wk_orderful_messages WHERE transaction_id = $1 AND tenant_id = $2`,
      [id, tenantId]
    ),
    query(
      `SELECT id, recipe_id, recipe_name, job_id, parent_job_id, master_job_id, job_url, direction, source_status,
              canonical_status, failure_stage, failure_step, failure_message, started_at, completed_at, duration_ms, steps, erp
         FROM wk_executions WHERE transaction_id = $1 AND tenant_id = $2 ORDER BY started_at DESC, id DESC`,
      [id, tenantId]
    ),
    query(
      `SELECT execution_id, stage_type, canonical_status, source_status, started_at, ended_at
         FROM wk_transaction_stages WHERE transaction_id = $1 AND tenant_id = $2`,
      [id, tenantId]
    ),
  ]);

  // Link to the transaction in Orderful's own UI, where the Rules Editor tab lists exact validation errors.
  // viewAs is the tenant's Orderful organisation id when it has saved one.
  if (message?.orderful_transaction_id) {
    const cred = await queryOne<{ extra: { viewAs?: string } }>(`SELECT extra FROM wk_tenant_credentials WHERE tenant_id = $1 AND kind = 'orderful' ORDER BY (environment = 'production') DESC LIMIT 1`, [tenantId]);
    const viewAs = cred?.extra?.viewAs;
    message.ui_url = `${env.ORDERFUL_UI_URL}/transactions/${encodeURIComponent(message.orderful_transaction_id)}${viewAs ? `?viewAs=${encodeURIComponent(viewAs)}` : ''}`;
  }

  const latest = executions.rows[0];
  const stageOf = (type: string) => stages.rows.find((s: any) => s.execution_id === latest?.id && s.stage_type === type) ?? null;
  const outbound = txn.direction === 'outbound';

  // Lanes in business order: Orderful -> Workato -> Target inbound, Source -> Workato -> Orderful outbound
  const lanes = {
    orderful: { type: 'orderful', label: LANE_LABELS.orderful, stage: stageOf('orderful'), data: message },
    workato: {
      type: 'workato',
      label: LANE_LABELS.workato,
      stage: stageOf('workato'),
      data: latest
        ? {
            recipeId: latest.recipe_id, recipeName: latest.recipe_name, jobId: latest.job_id, jobUrl: latest.job_url,
            durationMs: latest.duration_ms, failure: latest.failure_stage
              ? { stage: latest.failure_stage, step: latest.failure_step, message: latest.failure_message }
              : null,
            steps: latest.steps,
          }
        : null,
    },
    erp: {
      type: 'erp',
      label: outbound ? LANE_LABELS.erp_origin : LANE_LABELS.erp_destination,
      stage: stageOf('erp'),
      data: latest?.erp ?? null,
    },
  };
  const order = outbound ? [lanes.erp, lanes.workato, lanes.orderful] : [lanes.orderful, lanes.workato, lanes.erp];

  // Chronological, built from the timestamps the logs actually carry
  const timeline = [
    message?.orderful_created_at && { at: message.orderful_created_at, lane: 'orderful', event: 'Transaction created in Orderful' },
    ...executions.rows.flatMap((e: any) => [
      { at: e.started_at, lane: 'workato', event: `Job started (${e.recipe_name ?? e.recipe_id})`, jobId: e.job_id },
      e.completed_at && {
        at: e.completed_at, lane: 'workato', jobId: e.job_id,
        event: `Job ${e.source_status}${e.failure_stage ? ` at ${e.failure_stage}` : ''}`,
      },
    ]),
    message?.orderful_updated_at && { at: message.orderful_updated_at, lane: 'orderful', event: `Orderful last updated (${message.delivery_status ?? message.acknowledgment_status ?? 'n/a'})` },
  ]
    .filter(Boolean)
    .sort((a: any, b: any) => Date.parse(a.at) - Date.parse(b.at));

  // The business card's data is kept apart from the transaction row: it is what analysts and
  // executives read (and every role may), while raw EDI stays behind its own permission.
  const { edi_details, business_keys, details_extracted_at, ...transaction } = txn;
  const business = {
    available: !!details_extracted_at,
    extractedAt: details_extracted_at,
    primaryLabel: txn.primary_label,
    keys: business_keys ?? {},
    shipFrom: txn.ship_from,
    shipTo: txn.ship_to,
    soldTo: txn.sold_to,
    totalAmount: txn.total_amount === null ? null : Number(txn.total_amount),
    currency: txn.currency,
    documentDate: txn.document_date,
    details: edi_details ?? null,
    // Why there may be nothing: conversion is off for the tenant, hasn't run yet, or failed
    status: message?.raw_edi_status ?? null,
  };

  await auditPlatformRead(req, 'transactions.view', String(id));
  res.json({
    transaction,
    business,
    lanes: order,
    timeline,
    executions: executions.rows.map((e: any) => ({ ...e, steps: undefined, erp: undefined })),
  });
});

// ---------------------------------------------------------------- raw EDI (payload access)

/**
 * Raw EDI is customer payload data. Business and auditor roles never see it;
 * every read is audited, platform admins included.
 */
function requirePayloadAccess(req: any, res: any, next: any) {
  if (!["platform_admin", "customer_admin", "support"].includes(req.user?.role)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

router.get("/transactions/:id/raw-edi", requireTenantMember, requirePayloadAccess, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const m = await queryOne(
    `SELECT raw_edi, raw_edi_status, raw_edi_error, raw_edi_converted_at
       FROM wk_orderful_messages WHERE transaction_id = $1 AND tenant_id = $2`,
    [Number(req.params.id), tenantId]
  );
  if (!m) return res.status(404).json({ error: "No Orderful message for this transaction" });

  if (m.raw_edi_status !== "converted" || !m.raw_edi) {
    return res.json({ status: m.raw_edi_status, error: m.raw_edi_error, rawEdi: null });
  }

  let rawEdi: string;
  try {
    rawEdi = readRawEdi(m.raw_edi);
  } catch {
    // Stored under a previous encryption key; the source log still has the input, so it can be re-converted
    return res.status(409).json({ error: "Stored payload cannot be decrypted; re-convert to restore it" });
  }

  await audit(req, { action: "payload.view", tenantId, target: `transaction/${req.params.id}/raw-edi` });
  res.json({ status: "converted", convertedAt: m.raw_edi_converted_at, rawEdi });
});

router.post("/transactions/:id/raw-edi/convert", requireTenantMember, requirePayloadAccess, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const out = await convertNow(tenantId, Number(req.params.id));

  const statusFor: Record<string, number> = { not_found: 404, disabled: 409, no_credential: 409 };
  if (statusFor[out.result]) {
    const why: Record<string, string> = {
      not_found: "No Orderful message for this transaction",
      disabled: "Raw EDI conversion is not enabled for this tenant",
      no_credential: "No Orderful credential is configured for this tenant",
    };
    return res.status(statusFor[out.result]).json({ error: why[out.result] });
  }

  await audit(req, { action: "payload.convert", tenantId, target: `transaction/${req.params.id}`, outcome: out.result === "converted" || out.result === "skipped" ? "success" : "failure" });
  res.json({ result: out.result, error: out.error ?? null });
});

/**
 * Asks Orderful now (GET /v3/transactions/{id}) for the validation, delivery and acknowledgment status of a
 * transaction we sent, instead of waiting for the background check. Outbound only.
 */
router.post('/transactions/:id/orderful-status/refresh', requireTenantMember, async (req, res) => {
  if (!['platform_admin', 'customer_admin', 'support'].includes(req.user?.role ?? '')) return res.status(403).json({ error: 'Forbidden' });
  const tenantId = Number(req.params.tenantId);
  const out = await refreshTransactionNow(tenantId, Number(req.params.id));
  if (out.result === 'not_found') return res.status(404).json({ error: 'No Orderful transaction for this document' });
  if (out.result === 'not_outbound') return res.status(409).json({ error: 'Only transactions we sent are checked with Orderful this way' });
  if (out.result === 'no_credential' || out.result === 'error') return res.status(502).json({ error: out.error ?? 'Could not reach Orderful' });
  await audit(req, { action: 'orderful.status.refresh', tenantId, target: `transaction/${req.params.id}` });
  res.json({ result: out.result });
});

/**
 * Plain-language explanation of the document's EDI, from the tenant's own Gemini key. Same access as
 * raw EDI (the EDI itself is sent to Google), audited, cached per language, and limited per tenant.
 * ?refresh=1 asks for a fresh one.
 */
router.get('/transactions/:id/explain', requireTenantMember, requirePayloadAccess, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const id = Number(req.params.id);
  const language = String(req.query.language ?? 'English');
  if (!(LANGUAGES as readonly string[]).includes(language)) return res.status(400).json({ error: 'Unsupported language' });

  const m = await queryOne(`SELECT raw_edi, raw_edi_status FROM wk_orderful_messages WHERE transaction_id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (!m) return res.status(404).json({ error: 'No Orderful message for this transaction' });
  if (m.raw_edi_status !== 'converted' || !m.raw_edi) return res.status(409).json({ error: 'The raw EDI is not available yet, so there is nothing to explain. Convert it first.' });

  let rawEdi: string;
  try {
    rawEdi = readRawEdi(m.raw_edi);
  } catch {
    return res.status(409).json({ error: 'Stored payload cannot be decrypted; re-convert to restore it' });
  }

  const hash = hashEdi(rawEdi);
  if (req.query.refresh !== '1') {
    const cached = await queryOne(`SELECT html, model, created_at FROM wk_edi_explanations WHERE transaction_id = $1 AND language = $2 AND raw_hash = $3 AND tenant_id = $4`, [id, language, hash, tenantId]);
    if (cached) {
      await audit(req, { action: 'payload.explain', tenantId, target: `transaction/${id}`, details: { language, cached: true } });
      return res.json({ html: cached.html, language, cached: true, model: cached.model, createdAt: cached.created_at });
    }
  }

  if (!allowExplainRequest(tenantId)) return res.status(429).json({ error: 'Too many explanations requested. Try again in a minute.' });
  try {
    const t0 = Date.now();
    const { html, model, provider, usage } = await explainEdi(tenantId, rawEdi, language);
    recordActivity({ tenantId, channel: 'explain', action: 'explain', ok: true, httpStatus: 200, ms: Date.now() - t0, provider, model, inputTokens: usage?.input, outputTokens: usage?.output, cachedTokens: usage?.cached, costUsd: usage ? costOf(model, usage) : null });
    await query(
      `INSERT INTO wk_edi_explanations (tenant_id, transaction_id, language, raw_hash, html, model) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (transaction_id, language) DO UPDATE SET raw_hash = EXCLUDED.raw_hash, html = EXCLUDED.html, model = EXCLUDED.model, created_at = NOW()`,
      [tenantId, id, language, hash, html, model]
    );
    await audit(req, { action: 'payload.explain', tenantId, target: `transaction/${id}`, details: { language, cached: false } });
    res.json({ html, language, cached: false, model, createdAt: new Date().toISOString() });
  } catch (e) {
    if (e instanceof ExplainError) {
      await audit(req, { action: 'payload.explain', tenantId, target: `transaction/${id}`, outcome: 'failure' });
      recordActivity({ tenantId, channel: 'explain', action: 'explain', ok: false, httpStatus: e.status, detail: e.detail ?? e.message });
      return res.status(e.status).json({ error: e.message });
    }
    throw e;
  }
});

// ---------------------------------------------------------------- recipes

router.get('/recipes', requireTenantMember, async (req, res) => {
  const { rows } = await query(
    `SELECT c.recipe_id, c.recipe_name, c.direction, c.document_type, c.payload_step, c.target_system, c.is_active,
            c.ingest_mode, c.edi_seen_at, c.ignored_count::int AS ignored_count, c.last_ignored_at, c.last_ignored_reason,
            (SELECT COUNT(*)::int FROM wk_executions e WHERE e.tenant_id = c.tenant_id AND e.recipe_id = c.recipe_id) AS executions
       FROM wk_recipe_configs c WHERE c.tenant_id = $1 ORDER BY c.recipe_name NULLS LAST, c.recipe_id`,
    [req.params.tenantId]
  );
  res.json({ recipes: rows });
});

router.put('/recipes/:recipeId', requireTenantAccess, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const { direction, document_type, payload_step, target_system, is_active, ingest_mode } = req.body ?? {};
  if (ingest_mode !== undefined && !['auto', 'include', 'ignore'].includes(ingest_mode)) {
    return res.status(400).json({ error: 'ingest_mode must be "auto", "include" or "ignore"' });
  }

  if (direction != null && !['inbound', 'outbound'].includes(direction)) {
    return res.status(400).json({ error: 'direction must be "inbound", "outbound" or null' });
  }
  if (payload_step != null && !(Number.isInteger(payload_step) && payload_step >= 0)) {
    return res.status(400).json({ error: 'payload_step must be a non-negative integer' });
  }
  if (document_type != null && !/^[0-9A-Z]{2,10}$/.test(document_type)) {
    return res.status(400).json({ error: 'document_type must be 2-10 characters, e.g. "850"' });
  }

  const body = req.body ?? {};
  const row = await queryOne(
    `INSERT INTO wk_recipe_configs (tenant_id, recipe_id, direction, document_type, payload_step, target_system, is_active, ingest_mode)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, true), COALESCE($12, 'auto'))
     ON CONFLICT (tenant_id, recipe_id) DO UPDATE SET
       direction = CASE WHEN $8::boolean THEN EXCLUDED.direction ELSE wk_recipe_configs.direction END,
       document_type = CASE WHEN $9::boolean THEN EXCLUDED.document_type ELSE wk_recipe_configs.document_type END,
       payload_step = CASE WHEN $10::boolean THEN EXCLUDED.payload_step ELSE wk_recipe_configs.payload_step END,
       target_system = CASE WHEN $11::boolean THEN EXCLUDED.target_system ELSE wk_recipe_configs.target_system END,
       is_active = COALESCE($7, wk_recipe_configs.is_active),
       ingest_mode = COALESCE($12, wk_recipe_configs.ingest_mode)
     RETURNING recipe_id, recipe_name, direction, document_type, payload_step, target_system, is_active, ingest_mode`,
    [
      tenantId, req.params.recipeId, direction ?? null, document_type ?? null, payload_step ?? null, target_system ?? null, is_active ?? null,
      'direction' in body, 'document_type' in body, 'payload_step' in body, 'target_system' in body, ingest_mode ?? null,
    ]
  );

  // An override changes how past logs read, so they are re-normalized in the background
  const readingChanged = ['direction', 'document_type', 'payload_step', 'target_system', 'is_active'].some((k) => k in body);
  const queued = readingChanged ? await requestRenormalize(tenantId, req.params.recipeId) : 0;
  if (readingChanged) void normalizePending(500).catch(() => {});

  await audit(req, { action: 'recipe.configure', tenantId, target: req.params.recipeId, details: { fields: Object.keys(body) } });
  res.json({ recipe: row, renormalizing: queued });
});

export default router;
