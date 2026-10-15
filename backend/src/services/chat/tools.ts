import { randomUUID } from 'crypto';
import { query, queryOne } from '../../db/connection.js';
import { PARTNER_ID_SQL } from '../../utils/savedView.js';
import { findPending } from '../ackRule.service.js';
import { loadReportDocs, formatWhen } from '../reportData.service.js';
import { parseRule } from '../../routes/ackRules.routes.js';
import type { ToolDeclaration } from './gemini.js';

/**
 * What the assistant can do. Each tool is a small, tenant-scoped read over data the portal already shows,
 * or a "propose" tool that only prepares a confirmation card. A propose tool never changes anything: the
 * person clicks Confirm and the portal's own API (with its own validation, roles, limits and audit) does it.
 * Nothing here returns raw EDI.
 */

export type ProposalKind = 'create_997_rule' | 'create_ticket' | 'send_report' | 'comment_ticket';

export interface Proposal {
  id: string;
  kind: ProposalKind;
  title: string;
  details: [string, string][];
  /** Exactly what the portal API will be called with on Confirm */
  payload: Record<string, unknown>;
}

export interface ToolCtx {
  tenantId: number;
  userId: string;
  role: string;
  email: string;
  name: string;
  timezone: string;
  proposals: Proposal[];
}

export interface Tool {
  decl: ToolDeclaration;
  /** Roles allowed to use it; all roles when omitted */
  roles?: string[];
  run: (ctx: ToolCtx, args: Record<string, any>) => Promise<unknown>;
}

const ANY_DOC_ROLES = ['platform_admin', 'customer_admin', 'support', 'business'];
const CONFIG_VIEW = ['platform_admin', 'customer_admin', 'support'];
const ADMINS = ['platform_admin', 'customer_admin'];

const STATUSES = ['Received', 'In Progress', 'Transformed', 'Sent to ERP', 'ERP Acknowledged', 'Sent to Orderful', 'Delivered', 'Completed', 'Warning', 'Failed', 'Retrying', 'Unknown'];
const PRIORITIES = ['critical', 'high', 'medium', 'low'];
const EMAIL = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()"]+$/;

const PARTNER_NAME_SQL = `CASE t.direction WHEN 'inbound' THEN t.sender_name ELSE t.receiver_name END`;
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '');
const cap = <T>(a: T[], n: number) => a.slice(0, n);

/** What the Ack column shows, in words. The 997 is Orderful's to report; failed documents get no 997. */
export function ackSummary(r: { ack_tracked: boolean; validation_status: string | null; delivery_status: string | null; acknowledgment_status: string | null; has_orderful: boolean }): string {
  if (!r.ack_tracked) return 'not tracked for this partner';
  if (!r.has_orderful) return 'not known (no Orderful record)';
  if ((r.validation_status ?? '').toUpperCase() === 'INVALID') return 'N/A - failed Orderful validation, so no 997 is expected';
  if ((r.delivery_status ?? '').toUpperCase() === 'FAILED') return 'N/A - Orderful could not deliver it, so no 997 is expected';
  const ack = (r.acknowledgment_status ?? '').toUpperCase();
  if (ack === 'ACCEPTED') return 'accepted (997 received)';
  if (ack === 'REJECTED') return 'rejected (997 received with errors)';
  if (['SENT', 'DELIVERED'].includes((r.delivery_status ?? '').toUpperCase()) || ack) return 'awaiting 997 (none reported yet)';
  return 'not yet sent, so no 997 yet';
}

// ---------------------------------------------------------------- partners

export interface PartnerMatch { id: string; name: string | null }

/** Partners (far ends of documents) whose id equals, or whose name contains, the text. */
export async function matchPartners(tenantId: number, text: string): Promise<PartnerMatch[]> {
  const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { rows } = await query(
    `SELECT partner_id AS id, MAX(name) AS name FROM (
       SELECT ${PARTNER_ID_SQL} AS partner_id, ${PARTNER_NAME_SQL} AS name FROM wk_transactions t
        WHERE t.tenant_id = $1 AND t.direction IN ('inbound','outbound')) p
      WHERE partner_id IS NOT NULL AND (partner_id = $2 OR name ILIKE $3)
      GROUP BY partner_id ORDER BY MAX(name) LIMIT 10`,
    [tenantId, text, like]
  );
  const m = rows as PartnerMatch[];
  const exact = m.filter((p) => p.id === text || (p.name ?? '').toLowerCase() === text.toLowerCase());
  return exact.length === 1 ? exact : m;
}

type Resolved = { ok: true; partner: PartnerMatch | null } | { ok: false; result: unknown };

async function resolvePartner(ctx: ToolCtx, text: unknown): Promise<Resolved> {
  const t = str(text, 100);
  if (!t) return { ok: true, partner: null };
  const m = await matchPartners(ctx.tenantId, t);
  if (m.length === 1) return { ok: true, partner: m[0] };
  if (m.length === 0) {
    const known = (await query(`SELECT MAX(${PARTNER_NAME_SQL}) AS name FROM wk_transactions t WHERE t.tenant_id = $1 AND t.direction IN ('inbound','outbound') GROUP BY ${PARTNER_ID_SQL} ORDER BY 1 LIMIT 20`, [ctx.tenantId])).rows.map((r: any) => r.name);
    return { ok: false, result: { error: `No trading partner matches "${t}".`, known_partners: known } };
  }
  return { ok: false, result: { ambiguous_partner: true, message: `More than one partner matches "${t}". Ask the user which one.`, candidates: m } };
}

// ---------------------------------------------------------------- documents

const DOC_SELECT = `SELECT t.id, t.document_type, t.direction, t.business_number, t.canonical_status AS status, t.failure_stage,
       t.first_seen_at, t.last_activity_at, t.po_number, t.shipment_number, t.invoice_number, t.bol_number, t.total_amount, t.currency,
       (${PARTNER_ID_SQL}) AS partner_id, (${PARTNER_NAME_SQL}) AS partner_name,
       m.validation_status, m.delivery_status, m.acknowledgment_status, (m.transaction_id IS NOT NULL) AS has_orderful,
       COALESCE(CASE t.direction WHEN 'inbound' THEN ps.track_inbound_ack ELSE ps.expect_outbound_ack END, TRUE) AS ack_tracked
  FROM wk_transactions t
  LEFT JOIN LATERAL (SELECT transaction_id, validation_status, delivery_status, acknowledgment_status FROM wk_orderful_messages WHERE transaction_id = t.id LIMIT 1) m ON TRUE
  LEFT JOIN wk_partner_settings ps ON ps.tenant_id = t.tenant_id AND ps.partner_id = (${PARTNER_ID_SQL})`;

function shapeDoc(r: any, tz: string) {
  const refs = Object.entries({ PO: r.po_number, shipment: r.shipment_number, invoice: r.invoice_number, BOL: r.bol_number }).filter(([, v]) => v && v !== r.business_number);
  return {
    id: Number(r.id),
    link: `/transactions/${r.id}`,
    type: r.document_type,
    number: r.business_number,
    other_references: refs.length ? Object.fromEntries(refs) : undefined,
    direction: r.direction === 'inbound' ? 'inbound (received from partner)' : r.direction === 'outbound' ? 'outbound (sent to partner)' : r.direction,
    partner: r.partner_name,
    status: r.status,
    stopped_at: r.failure_stage ?? undefined,
    amount: r.total_amount ? `${r.currency ?? ''} ${r.total_amount}`.trim() : undefined,
    first_seen: formatWhen(r.first_seen_at ? new Date(r.first_seen_at).toISOString() : null, tz),
    last_activity: formatWhen(r.last_activity_at ? new Date(r.last_activity_at).toISOString() : null, tz),
    orderful: r.has_orderful ? { validation: r.validation_status, delivery: r.delivery_status } : undefined,
    '997': ackSummary(r),
  };
}

const findDocuments: Tool = {
  decl: {
    name: 'find_documents',
    description: 'Search EDI documents of this organisation. Use for "did we receive order 100 from X", "show failed 855s", "what happened to PO 123". Inbound = received from a partner, outbound = sent to a partner. Each result includes its 997 (acknowledgment) status. Returns at most 10, newest first, plus the total. Summary only: no items or addresses, so follow with get_document when those are asked.',
    parameters: {
      type: 'OBJECT',
      properties: {
        number: { type: 'STRING', description: 'A PO, order, shipment, invoice or BOL number, exactly as the user gave it (without #)' },
        partner: { type: 'STRING', description: 'Trading partner name or ISA id (partial name is fine)' },
        document_type: { type: 'STRING', description: 'X12 transaction set, e.g. 850, 855, 856, 810, 997' },
        direction: { type: 'STRING', enum: ['inbound', 'outbound'] },
        status: { type: 'STRING', description: `One of: ${STATUSES.join(', ')}` },
        days_back: { type: 'INTEGER', description: 'Only documents active in the last N days' },
      },
    },
  },
  async run(ctx, a) {
    const p = await resolvePartner(ctx, a.partner);
    if (!p.ok) return p.result;
    const params: unknown[] = [ctx.tenantId];
    const where = ['t.tenant_id = $1'];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };

    if (p.partner) add(`(${PARTNER_ID_SQL}) = ?`, p.partner.id);
    const type = str(a.document_type, 10).toUpperCase();
    if (type) add('t.document_type = ?', type);
    if (a.direction === 'inbound' || a.direction === 'outbound') add('t.direction = ?', a.direction);
    if (a.status) {
      const s = STATUSES.find((x) => x.toLowerCase() === str(a.status, 40).toLowerCase());
      if (!s) return { error: `Unknown status "${str(a.status, 40)}".`, valid_statuses: STATUSES };
      add('t.canonical_status = ?', s);
    }
    const days = Number(a.days_back);
    if (Number.isFinite(days) && days > 0) add(`t.last_activity_at >= NOW() - make_interval(days => ?::int)`, Math.min(Math.floor(days), 365));
    const num = str(a.number, 80).replace(/^#/, '');
    if (num) {
      params.push(num);
      const n = `$${params.length}`;
      where.push(`(upper(t.business_number) = upper(${n}) OR upper(t.po_number) = upper(${n}) OR upper(t.shipment_number) = upper(${n}) OR upper(t.invoice_number) = upper(${n}) OR upper(t.bol_number) = upper(${n}))`);
    }
    if (where.length === 1) return { error: 'Give at least one filter: a number, a partner, a document type, a status or a time window.' };

    const w = where.join(' AND ');
    const [list, count] = await Promise.all([
      query(`${DOC_SELECT} WHERE ${w} ORDER BY t.last_activity_at DESC NULLS LAST, t.id DESC LIMIT 10`, params),
      queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM wk_transactions t WHERE ${w}`, params),
    ]);
    return { total: count?.n ?? 0, shown: list.rows.length, documents: list.rows.map((r) => shapeDoc(r, ctx.timezone)), searched_partner: p.partner ?? undefined };
  },
};

const getDocument: Tool = {
  decl: {
    name: 'get_document',
    description: 'Full picture of one document by its portal id (from find_documents): status, where it failed, Orderful validation/delivery/997, Workato and ERP steps, business details and linked tickets.',
    parameters: { type: 'OBJECT', properties: { id: { type: 'INTEGER', description: 'The document id' } }, required: ['id'] },
  },
  async run(ctx, a) {
    const id = Number(a.id);
    if (!Number.isSafeInteger(id) || id <= 0) return { error: 'A valid document id is required.' };
    const row = (await query(`${DOC_SELECT} WHERE t.tenant_id = $1 AND t.id = $2`, [ctx.tenantId, id])).rows[0];
    if (!row) return { error: 'No such document in this organisation.' };
    const [doc] = await loadReportDocs(ctx.tenantId, [id]);
    const tickets = (await query(
      `SELECT t.id, t.external_key, t.status FROM wk_tickets t JOIN wk_ticket_transactions x ON x.ticket_id = t.id WHERE t.tenant_id = $1 AND x.transaction_id = $2 ORDER BY t.created_at DESC LIMIT 5`, [ctx.tenantId, id])).rows;
    return {
      ...shapeDoc(row, ctx.timezone),
      failure_message: doc?.failureMessage ?? undefined,
      environment: doc?.environment,
      stages: doc?.lanes?.map((l) => ({ stage: l.label, status: l.status, detail: l.detail ?? undefined })),
      business: doc ? { ship_from: doc.business.shipFrom, ship_to: doc.business.shipTo, sold_to: doc.business.soldTo, document_date: doc.business.documentDate, line_count: doc.business.lineCount, first_lines: cap(doc.business.lines, 5).map((l) => ({ product: l.product, quantity: l.quantity, uom: l.uom })) } : undefined,
      tickets: tickets.map((t: any) => ({ id: t.id, key: t.external_key, status: t.status, link: `/tickets/${t.id}` })),
    };
  },
};

const pending997: Tool = {
  decl: {
    name: 'pending_997',
    description: 'Documents still waiting for a 997 acknowledgment for more than N hours (default 24), as last reported by Orderful. Excludes documents that failed validation or delivery and partners whose 997 is not tracked.',
    parameters: {
      type: 'OBJECT',
      properties: {
        partner: { type: 'STRING', description: 'Trading partner name or id; omit for all partners' },
        hours: { type: 'INTEGER', description: 'Waiting longer than this many hours (1 to 720)' },
        direction: { type: 'STRING', enum: ['inbound', 'outbound', 'both'] },
        document_type: { type: 'STRING', description: 'Only this transaction set, e.g. 855' },
      },
    },
  },
  async run(ctx, a) {
    const p = await resolvePartner(ctx, a.partner);
    if (!p.ok) return p.result;
    const hours = Math.min(Math.max(Math.floor(Number(a.hours)) || 24, 1), 720);
    const type = str(a.document_type, 10).toUpperCase();
    const direction = ['inbound', 'outbound', 'both'].includes(a.direction) ? a.direction : 'both';
    const docs = await findPending({ tenant_id: ctx.tenantId, partner_id: p.partner?.id ?? null, document_types: type ? [type] : null, direction, threshold_hours: hours });
    return {
      waiting_more_than_hours: hours, direction, partner: p.partner?.name ?? 'all partners', total: docs.length,
      documents: cap(docs, 15).map((d) => ({ id: Number(d.id), link: `/transactions/${d.id}`, type: d.document_type, number: d.business_number, partner: d.partner_name, direction: d.direction, hours_waiting: d.hours_waiting, ack: d.ack })),
    };
  },
};

// ---------------------------------------------------------------- partners, tickets, rules

const listPartners: Tool = {
  decl: { name: 'list_partners', description: 'The trading partners seen in this organisation\'s traffic, with document counts and whether their 997 is tracked. Use to offer choices when the user has not said which partner.', parameters: { type: 'OBJECT', properties: {} } },
  async run(ctx) {
    const { rows } = await query(
      `SELECT p.partner_id AS id, MAX(p.name) AS name, COUNT(*)::int AS documents,
              COALESCE(s.track_inbound_ack, TRUE) AS inbound_997_tracked, COALESCE(s.expect_outbound_ack, TRUE) AS outbound_997_expected
         FROM (SELECT ${PARTNER_ID_SQL} AS partner_id, ${PARTNER_NAME_SQL} AS name FROM wk_transactions t WHERE t.tenant_id = $1 AND t.direction IN ('inbound','outbound')) p
         LEFT JOIN wk_partner_settings s ON s.tenant_id = $1 AND s.partner_id = p.partner_id
        WHERE p.partner_id IS NOT NULL GROUP BY p.partner_id, s.track_inbound_ack, s.expect_outbound_ack ORDER BY documents DESC LIMIT 30`, [ctx.tenantId]);
    return { partners: rows };
  },
};

const listTickets: Tool = {
  decl: {
    name: 'list_tickets',
    description: 'Tickets raised from the portal in Jira or ServiceNow, with their latest status as last read from there.',
    parameters: { type: 'OBJECT', properties: { open_only: { type: 'BOOLEAN', description: 'Hide finished tickets' }, key: { type: 'STRING', description: 'A ticket key like SUP-1 to look up one ticket' } } },
  },
  roles: ANY_DOC_ROLES,
  async run(ctx, a) {
    const key = str(a.key, 40);
    const { rows } = await query(
      `SELECT t.id, t.external_key, t.provider, t.summary, t.priority, t.status, t.status_category, t.assignee, t.created_at, t.synced_at, t.sync_error,
              (SELECT json_agg(json_build_object('id', tr.id, 'type', tr.document_type, 'number', tr.business_number)) FROM wk_ticket_transactions x JOIN wk_transactions tr ON tr.id = x.transaction_id WHERE x.ticket_id = t.id) AS documents
         FROM wk_tickets t WHERE t.tenant_id = $1 AND ($2::text = '' OR upper(t.external_key) = upper($2))
          AND ($3::boolean IS FALSE OR COALESCE(t.status_category, 'open') <> 'done') ORDER BY t.created_at DESC LIMIT 10`, [ctx.tenantId, key, a.open_only === true]);
    return { tickets: rows.map((t: any) => ({ id: t.id, link: `/tickets/${t.id}`, key: t.external_key, system: t.provider, summary: t.summary, priority: t.priority, status: t.status ?? 'not read yet', assignee: t.assignee ?? 'unassigned', raised: formatWhen(new Date(t.created_at).toISOString(), ctx.timezone), last_read: t.synced_at ? formatWhen(new Date(t.synced_at).toISOString(), ctx.timezone) : undefined, read_error: t.sync_error ?? undefined, documents: t.documents ?? [] })) };
  },
};

const list997Rules: Tool = {
  decl: { name: 'list_997_rules', description: 'The 997 reminder rules that email people when an acknowledgment is overdue.', parameters: { type: 'OBJECT', properties: {} } },
  roles: CONFIG_VIEW,
  async run(ctx) {
    const { rows } = await query(
      `SELECT r.id, r.name, r.partner_id, r.document_types, r.direction, r.threshold_hours, r.recipients, r.send_times, r.is_active, r.last_run_at, r.last_run_status, r.last_run_count FROM wk_ack_rules r WHERE r.tenant_id = $1 ORDER BY r.created_at DESC LIMIT 20`, [ctx.tenantId]);
    return { rules: rows.map((r: any) => ({ name: r.name, partner: r.partner_id ?? 'all partners', document_types: r.document_types ?? 'all', direction: r.direction, pending_more_than_hours: r.threshold_hours, emails: r.recipients, sends_at: r.send_times.length ? r.send_times : 'on demand only', active: r.is_active, last_run: r.last_run_at ? formatWhen(new Date(r.last_run_at).toISOString(), ctx.timezone) : 'never', last_result: r.last_run_status ?? undefined })) };
  },
};

// ---------------------------------------------------------------- proposals (nothing happens until the person confirms)

const NOTE = 'A confirmation card is now shown to the user. Nothing has been created or sent yet; tell the user to review it and press Confirm.';

function propose(ctx: ToolCtx, p: Omit<Proposal, 'id'>) {
  if (ctx.proposals.length >= 3) return { error: 'Too many pending actions in one message. Finish these first.' };
  ctx.proposals.push({ id: randomUUID(), ...p });
  return { ok: true, note: NOTE };
}

const proposeRule: Tool = {
  decl: {
    name: 'propose_997_rule',
    description: 'Prepare a 997 reminder rule: email people when a partner\'s 997 is still missing after N hours. Only prepares a card for the user to confirm. If the user did not say who to email, use their own address (leave recipients out). Ask the user for the partner and the hours if they are not clear.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: 'Short rule name; make one up from the partner if the user gave none' },
        partner: { type: 'STRING', description: 'Trading partner name or id; omit for all partners' },
        hours: { type: 'INTEGER', description: 'Alert when the 997 has been pending more than this many hours' },
        direction: { type: 'STRING', enum: ['inbound', 'outbound', 'both'], description: 'Default both' },
        document_types: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Only these transaction sets; omit for all' },
        recipients: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Emails; default is the requesting user' },
        send_times: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Times of day HH:MM in the organisation time zone, up to 2; default 08:00 and 17:00; empty for on demand only' },
      },
      required: ['hours'],
    },
  },
  roles: ADMINS,
  async run(ctx, a) {
    const p = await resolvePartner(ctx, a.partner);
    if (!p.ok) return p.result;
    const body = {
      name: str(a.name, 80) || `${p.partner?.name ?? 'All partners'} 997 overdue`,
      partnerId: p.partner?.id ?? null,
      documentTypes: Array.isArray(a.document_types) ? a.document_types : [],
      direction: a.direction ?? 'both',
      thresholdHours: Number(a.hours),
      recipients: Array.isArray(a.recipients) && a.recipients.length ? a.recipients : [ctx.email],
      sendTimes: Array.isArray(a.send_times) ? a.send_times : ['08:00', '17:00'],
    };
    const parsed = parseRule(body);
    if (!parsed.ok) return { error: parsed.error };
    const v = parsed.v;
    return propose(ctx, {
      kind: 'create_997_rule',
      title: 'Create 997 reminder rule',
      details: [
        ['Name', v.name], ['Partner', p.partner?.name ?? p.partner?.id ?? 'All partners'], ['Documents', v.document_types?.join(', ') ?? 'All types'],
        ['Direction', v.direction], ['Alert when 997 pending more than', `${v.threshold_hours} hours`],
        ['Sends', v.send_times.length ? `${v.send_times.join(' and ')} (${ctx.timezone})` : 'On demand only'], ['Emails', v.recipients.join(', ')],
      ],
      payload: { ...body, name: v.name, direction: v.direction, recipients: v.recipients, sendTimes: v.send_times, documentTypes: v.document_types ?? [] },
    });
  },
};

async function ownDocs(ctx: ToolCtx, ids: unknown) {
  const list = Array.isArray(ids) ? [...new Set(ids.map(Number))] : [];
  if (list.length < 1 || list.length > 25 || list.some((n) => !Number.isSafeInteger(n) || n <= 0)) return { error: 'Give 1 to 25 document ids (from find_documents).' } as const;
  const docs = await loadReportDocs(ctx.tenantId, list);
  if (docs.length !== list.length) return { error: 'One or more of those documents were not found in this organisation.' } as const;
  return { docs };
}

const proposeTicket: Tool = {
  decl: {
    name: 'propose_ticket',
    description: 'Prepare a Jira/ServiceNow ticket for one or more documents. Only prepares a card for the user to confirm. Needs the reason in the user\'s words and a priority; ask if missing.',
    parameters: {
      type: 'OBJECT',
      properties: {
        document_ids: { type: 'ARRAY', items: { type: 'INTEGER' }, description: 'Portal document ids from find_documents' },
        reason: { type: 'STRING', description: 'Why the ticket is being raised, from the user' },
        priority: { type: 'STRING', enum: PRIORITIES },
        summary: { type: 'STRING', description: 'Optional ticket title' },
      },
      required: ['document_ids', 'reason', 'priority'],
    },
  },
  roles: ANY_DOC_ROLES,
  async run(ctx, a) {
    const reason = str(a.reason, 2000);
    if (reason.length < 5) return { error: 'The reason must be at least 5 characters. Ask the user why.' };
    if (!PRIORITIES.includes(a.priority)) return { error: `Priority must be one of ${PRIORITIES.join(', ')}.` };
    const cfg = await queryOne<{ ticket_provider: string | null }>(`SELECT ticket_provider FROM wk_tenants WHERE id = $1`, [ctx.tenantId]);
    if (!cfg?.ticket_provider) return { error: 'No ticket system (Jira or ServiceNow) is set up for this organisation. An administrator can connect one on the tenant page.' };
    const r = await ownDocs(ctx, a.document_ids);
    if ('error' in r) return r;
    const summary = str(a.summary, 250);
    return propose(ctx, {
      kind: 'create_ticket',
      title: `Create ${cfg.ticket_provider === 'jira' ? 'Jira' : 'ServiceNow'} ticket`,
      details: [['Documents', r.docs.map((d) => `${d.documentType ?? 'EDI'} ${d.number ?? `#${d.id}`}`).join(', ')], ['Priority', a.priority], ['Reason', reason], ...(summary ? ([['Title', summary]] as [string, string][]) : [])],
      payload: { transactionIds: r.docs.map((d) => d.id), reason, priority: a.priority, summary: summary || undefined },
    });
  },
};

const proposeReport: Tool = {
  decl: {
    name: 'propose_email_report',
    description: 'Prepare an emailed business-and-technical report on one or more documents. Only prepares a card for the user to confirm. Needs the recipient email(s) and a subject; ask if missing. Never invent addresses.',
    parameters: {
      type: 'OBJECT',
      properties: {
        document_ids: { type: 'ARRAY', items: { type: 'INTEGER' }, description: 'Portal document ids from find_documents' },
        to: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Recipient emails typed by the user (up to 5)' },
        subject: { type: 'STRING' },
        note: { type: 'STRING', description: 'Optional message shown at the top' },
      },
      required: ['document_ids', 'to', 'subject'],
    },
  },
  roles: ANY_DOC_ROLES,
  async run(ctx, a) {
    const to = [...new Set((Array.isArray(a.to) ? a.to : []).map((x: unknown) => str(x, 200).toLowerCase()).filter(Boolean))];
    if (to.length < 1 || to.length > 5) return { error: 'Give 1 to 5 recipient email addresses.' };
    const bad = to.find((x) => !EMAIL.test(x));
    if (bad) return { error: `"${bad}" is not a valid email address.` };
    const subject = str(a.subject, 150).replace(/[\r\n]+/g, ' ');
    if (subject.length < 3) return { error: 'The subject must be at least 3 characters.' };
    const r = await ownDocs(ctx, a.document_ids);
    if ('error' in r) return r;
    const note = str(a.note, 2000);
    return propose(ctx, {
      kind: 'send_report',
      title: 'Email a report',
      details: [['To', to.join(', ')], ['Subject', subject], ['Documents', r.docs.map((d) => `${d.documentType ?? 'EDI'} ${d.number ?? `#${d.id}`}`).join(', ')], ...(note ? ([['Message', note]] as [string, string][]) : [])],
      payload: { transactionIds: r.docs.map((d) => d.id), to, subject, note: note || undefined },
    });
  },
};

const proposeComment: Tool = {
  decl: {
    name: 'propose_ticket_comment',
    description: 'Prepare a comment on an existing ticket (it is posted to Jira/ServiceNow). Only prepares a card for the user to confirm.',
    parameters: { type: 'OBJECT', properties: { ticket_key: { type: 'STRING', description: 'e.g. SUP-1' }, comment: { type: 'STRING' } }, required: ['ticket_key', 'comment'] },
  },
  roles: ANY_DOC_ROLES,
  async run(ctx, a) {
    const comment = str(a.comment, 4000);
    if (comment.length < 2) return { error: 'Write the comment first.' };
    const t = await queryOne<{ id: number; external_key: string }>(`SELECT id, external_key FROM wk_tickets WHERE tenant_id = $1 AND upper(external_key) = upper($2)`, [ctx.tenantId, str(a.ticket_key, 40)]);
    if (!t) return { error: `No ticket ${str(a.ticket_key, 40)} was raised from this portal.` };
    return propose(ctx, { kind: 'comment_ticket', title: `Comment on ${t.external_key}`, details: [['Ticket', t.external_key], ['Comment', comment]], payload: { ticketId: Number(t.id), body: comment } });
  },
};

export const TOOLS: Tool[] = [findDocuments, getDocument, pending997, listPartners, listTickets, list997Rules, proposeRule, proposeTicket, proposeReport, proposeComment];
