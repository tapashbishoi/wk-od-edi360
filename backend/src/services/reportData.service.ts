import { env } from '../config/env.js';
import { query, queryOne } from '../db/connection.js';
import { mainNumber } from '../utils/docNumber.js';

/**
 * Everything the ticket and the emailed report say about a document, read from what the portal already
 * holds. Metadata and business facts only: raw EDI never goes to a ticket system or an email.
 */

export interface ReportLane {
  type: 'orderful' | 'workato' | 'erp';
  label: string;
  status: string;
  detail: string | null;
}

export interface ReportStep {
  n: number;
  kind: string;
  adapter: string;
  operation: string;
  ok: boolean;
  error?: string;
}

export interface ReportDoc {
  id: number;
  portalUrl: string;
  orderfulUrl: string | null;
  documentType: string | null;
  number: string | null;
  numberLabel: string;
  direction: string;
  status: string;
  failureStage: string | null;
  failureMessage: string | null;
  environment: string;
  sender: string | null;
  receiver: string | null;
  firstSeenAt: string | null;
  lastActivityAt: string | null;
  runs: number;
  timezone: string;
  business: {
    shipFrom: string | null;
    shipTo: string | null;
    soldTo: string | null;
    totalAmount: number | null;
    currency: string | null;
    documentDate: string | null;
    refs: [string, string][];
    lines: { product: string | null; description: string | null; quantity: number | null; uom: string | null; unitPrice: number | null; status: string | null }[];
    lineCount: number | null;
  };
  orderful: {
    transactionId: string | null;
    validation: string | null;
    delivery: string | null;
    acknowledgment: string | null;
    isa: string | null;
    gs: string | null;
    st: string | null;
  } | null;
  workato: {
    recipeName: string | null;
    recipeId: string | null;
    jobId: string | null;
    jobUrl: string | null;
    sourceStatus: string | null;
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    steps: ReportStep[];
  } | null;
  lanes: ReportLane[];
}

const LABELS = { orderful: 'Orderful', workato: 'Workato', erp_dest: 'Target system (ERP)', erp_origin: 'Source system (ERP)' };

const NUMBER_LABEL: Record<string, string> = { invoice: 'Invoice #', shipment: 'Shipment #', po: 'PO #', bol: 'BOL #' };
const labelFor = (primary: string | null, fallback: string) => {
  const l = (primary ?? '').toLowerCase();
  return NUMBER_LABEL[Object.keys(NUMBER_LABEL).find((k) => l.startsWith(k)) ?? ''] ?? fallback;
};

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const s = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : v === null || v === undefined ? null : String(v));

/** Loads the given transactions of one tenant, in the order asked. Ids that are not the tenant's are left out. */
export async function loadReportDocs(tenantId: number, ids: number[]): Promise<ReportDoc[]> {
  if (ids.length === 0) return [];

  const tenant = await queryOne<{ timezone: string }>(`SELECT timezone FROM wk_tenants WHERE id = $1`, [tenantId]);
  const cred = await queryOne<{ extra: { viewAs?: string } }>(`SELECT extra FROM wk_tenant_credentials WHERE tenant_id = $1 AND kind = 'orderful' ORDER BY (environment = 'production') DESC LIMIT 1`, [tenantId]);
  const timezone = tenant?.timezone ?? 'UTC';

  const { rows: txns } = await query<any>(
    `SELECT id, document_type, direction, canonical_status, failure_stage, environment, business_number, primary_label,
            po_number, shipment_number, invoice_number, bol_number, sender_name, sender_id, receiver_name, receiver_id,
            ship_from, ship_to, sold_to, total_amount, currency, document_date, edi_details, first_seen_at, last_activity_at, execution_count
       FROM wk_transactions WHERE tenant_id = $1 AND id = ANY($2::bigint[])`,
    [tenantId, ids]
  );
  const byId = new Map<number, any>(txns.map((t: any) => [Number(t.id), t]));

  const [msgs, execs, stages] = await Promise.all([
    query<any>(
      `SELECT transaction_id, orderful_transaction_id, validation_status, delivery_status, acknowledgment_status,
              isa_control_number, gs_control_number, st_control_number
         FROM wk_orderful_messages WHERE tenant_id = $1 AND transaction_id = ANY($2::bigint[])`,
      [tenantId, ids]
    ),
    query<any>(
      `SELECT DISTINCT ON (transaction_id) transaction_id, id, recipe_id, recipe_name, job_id, job_url, source_status,
              failure_message, started_at, completed_at, duration_ms, steps, erp
         FROM wk_executions WHERE tenant_id = $1 AND transaction_id = ANY($2::bigint[])
        ORDER BY transaction_id, started_at DESC, id DESC`,
      [tenantId, ids]
    ),
    query<any>(`SELECT transaction_id, execution_id, stage_type, canonical_status FROM wk_transaction_stages WHERE tenant_id = $1 AND transaction_id = ANY($2::bigint[])`, [tenantId, ids]),
  ]);

  const out: ReportDoc[] = [];
  for (const id of ids) {
    const t = byId.get(id);
    if (!t) continue;
    const m = msgs.rows.find((x: any) => Number(x.transaction_id) === id);
    const e = execs.rows.find((x: any) => Number(x.transaction_id) === id);
    const stageStatus = (type: string) => stages.rows.find((x: any) => Number(x.transaction_id) === id && x.execution_id === e?.id && x.stage_type === type)?.canonical_status ?? 'Unknown';
    const outbound = t.direction === 'outbound';
    const erp = e?.erp as { system?: string; operation?: string; ok?: boolean } | null;
    const details = (t.edi_details ?? {}) as Record<string, any>;

    const refs: [string, string][] = ([['PO #', t.po_number], ['Shipment #', t.shipment_number], ['Invoice #', t.invoice_number], ['BOL #', t.bol_number]] as [string, string | null][])
      .filter(([, v]) => !!v) as [string, string][];
    const lines = (Array.isArray(details.lineItems) ? details.lineItems : []).slice(0, 15).map((l: any) => ({
      product: s(l.productId ?? l.sku ?? l.upc),
      description: s(l.description),
      quantity: num(l.quantity),
      uom: s(l.uom),
      unitPrice: num(l.unitPrice),
      status: s(l.statusLabel ?? l.statusCode),
    }));

    const orderfulLane: ReportLane = { type: 'orderful', label: LABELS.orderful, status: stageStatus('orderful'), detail: m ? [m.validation_status && `Validation ${m.validation_status}`, m.delivery_status && `Delivery ${m.delivery_status}`, m.acknowledgment_status && `Ack ${m.acknowledgment_status}`].filter(Boolean).join(' · ') || null : null };
    const workatoLane: ReportLane = { type: 'workato', label: LABELS.workato, status: stageStatus('workato'), detail: e ? `${e.recipe_name ?? `Recipe ${e.recipe_id}`}` : null };
    const erpLane: ReportLane = { type: 'erp', label: outbound ? LABELS.erp_origin : LABELS.erp_dest, status: stageStatus('erp'), detail: erp ? `${erp.system ?? 'system'}${erp.operation ? `: ${erp.operation}` : ''}` : null };

    out.push({
      id,
      portalUrl: `${env.PORTAL_URL.replace(/\/+$/, '')}/transactions/${id}`,
      orderfulUrl: m?.orderful_transaction_id ? `${env.ORDERFUL_UI_URL}/transactions/${encodeURIComponent(m.orderful_transaction_id)}${cred?.extra?.viewAs ? `?viewAs=${encodeURIComponent(cred.extra.viewAs)}` : ''}` : null,
      documentType: t.document_type,
      number: mainNumber(t),
      numberLabel: labelFor(t.primary_label, 'Document #'),
      direction: t.direction,
      status: t.canonical_status,
      failureStage: t.failure_stage,
      failureMessage: s(e?.failure_message),
      environment: t.environment,
      sender: t.sender_name ?? t.sender_id,
      receiver: t.receiver_name ?? t.receiver_id,
      firstSeenAt: iso(t.first_seen_at),
      lastActivityAt: iso(t.last_activity_at),
      runs: Number(t.execution_count ?? 1),
      timezone,
      business: {
        shipFrom: s(t.ship_from), shipTo: s(t.ship_to), soldTo: s(t.sold_to),
        totalAmount: num(t.total_amount), currency: s(t.currency),
        documentDate: t.document_date ? String(t.document_date).slice(0, 10) : null,
        refs, lines, lineCount: num(details.lineItemCount) ?? (lines.length || null),
      },
      orderful: m ? { transactionId: m.orderful_transaction_id, validation: m.validation_status, delivery: m.delivery_status, acknowledgment: m.acknowledgment_status, isa: m.isa_control_number, gs: m.gs_control_number, st: m.st_control_number } : null,
      workato: e ? {
        recipeName: e.recipe_name, recipeId: e.recipe_id, jobId: e.job_id, jobUrl: /^https:\/\//i.test(e.job_url ?? '') ? e.job_url : null,
        sourceStatus: e.source_status, startedAt: iso(e.started_at), completedAt: iso(e.completed_at), durationMs: e.duration_ms,
        steps: (Array.isArray(e.steps) ? e.steps : []).map((x: any) => ({ n: x.n, kind: x.kind, adapter: x.adapter, operation: x.operation, ok: !!x.ok, ...(x.error ? { error: String(x.error).slice(0, 300) } : {}) })),
      } : null,
      lanes: outbound ? [erpLane, workatoLane, orderfulLane] : [orderfulLane, workatoLane, erpLane],
    });
  }
  return out;
}

/** "Oct 9, 2026, 5:08 AM" in the tenant's own time zone. */
export function formatWhen(isoTime: string | null, timeZone: string): string {
  if (!isoTime) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(isoTime));
  } catch {
    return new Date(isoTime).toUTCString();
  }
}
