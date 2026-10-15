import { Router, type Request, type Response } from 'express';
import { query, queryOne, transaction } from '../db/connection.js';
import { authMiddleware, requireActiveTenant, requireTenantMember } from '../middleware/auth.middleware.js';
import { audit } from '../services/audit.service.js';
import { brevoConfig, sendTenantEmail } from '../services/email.service.js';
import { loadReportDocs } from '../services/reportData.service.js';
import { buildTicket } from '../services/ticketText.js';
import { buildReportEmail } from '../services/reportEmail.js';
import { PORTAL_COMMENT_MARK, PRIORITIES, TicketError, addComment, createTicket, listTransitions, loadTicketConfig, transitionTicket, type Priority } from '../services/ticketing.service.js';
import { syncTicket } from '../services/ticketSync.service.js';

/**
 * What a person does ABOUT a document, from the documents list or the document page:
 *   - raise a ticket in the tenant's Jira or ServiceNow, with the document's facts filled in
 *   - email a report on it to someone, with a business section and a technical section
 * (Not the same as email alerts, which a user subscribes to for FUTURE documents.)
 *
 * Open to every role that reads documents except auditors. Both are rate limited per user, audited, and
 * carry metadata and business facts only: raw EDI never leaves the portal this way.
 */
const router = Router({ mergeParams: true });
router.use(authMiddleware, requireActiveTenant, requireTenantMember);

const ROLES = ['platform_admin', 'customer_admin', 'support', 'business'];
router.use((req: Request, res: Response, next) => (ROLES.includes(req.user?.role ?? '') ? next() : res.status(403).json({ error: 'Forbidden' })));

const MAX_DOCS = 25;
const tenantIdOf = (req: Request) => Number(req.params.tenantId);

/** Per-user hourly allowance for an action. In memory: a restart resets it, which is fine for abuse control. */
function limiter(max: number) {
  const hits = new Map<string, number[]>();
  return (key: string, now = Date.now()) => {
    const list = (hits.get(key) ?? []).filter((t) => now - t < 3_600_000);
    if (list.length >= max) {
      hits.set(key, list);
      return false;
    }
    list.push(now);
    hits.set(key, list);
    return true;
  };
}
const allowTicket = limiter(30);
const allowReport = limiter(20);
const allowTicketWrite = limiter(60);

function parseIds(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_DOCS) return null;
  const ids = raw.map((x) => (typeof x === 'number' || (typeof x === 'string' && /^\d{1,18}$/.test(x)) ? Number(x) : NaN));
  if (ids.some((n) => !Number.isSafeInteger(n) || n <= 0)) return null;
  return [...new Set(ids)];
}

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '');
/** A header value must never carry a line break: that is how a subject becomes extra headers. */
const oneLine = (v: unknown, max: number) => clean(v, max).replace(/[\r\n]+/g, ' ');

async function whoIs(req: Request) {
  const u = await queryOne<{ email: string; first_name: string | null; last_name: string | null }>(`SELECT email, first_name, last_name FROM wk_users WHERE id = $1`, [req.user!.userId]);
  const name = [u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.email || 'A portal user';
  return { email: u?.email ?? '', name };
}

// ---------------------------------------------------------------- tickets

router.get('/ticketing', async (req, res) => {
  const t = await queryOne<{ ticket_provider: string | null }>(`SELECT ticket_provider FROM wk_tenants WHERE id = $1`, [tenantIdOf(req)]);
  res.json({ provider: t?.ticket_provider ?? null });
});

router.post('/tickets', async (req, res) => {
  const tenantId = tenantIdOf(req);
  const ids = parseIds(req.body?.transactionIds);
  if (!ids) return res.status(400).json({ error: `Choose between 1 and ${MAX_DOCS} documents.` });
  const reason = clean(req.body?.reason, 2000);
  if (reason.length < 5) return res.status(400).json({ error: 'Say why you are raising this ticket (at least 5 characters).' });
  const priority = req.body?.priority as Priority;
  if (!PRIORITIES.includes(priority)) return res.status(400).json({ error: `Priority must be one of: ${PRIORITIES.join(', ')}.` });

  const cfg = await loadTicketConfig(tenantId);
  if (!cfg) return res.status(409).json({ error: 'No ticket system is set up for this organisation. An administrator can connect Jira or ServiceNow on the tenant page.' });
  if (!allowTicket(`${tenantId}:${req.user!.userId}`)) return res.status(429).json({ error: 'That is a lot of tickets in an hour. Try again later.' });

  const docs = await loadReportDocs(tenantId, ids);
  if (docs.length !== ids.length) return res.status(404).json({ error: 'One or more documents were not found.' });

  const me = await whoIs(req);
  const content = buildTicket({ docs, reason, priority, requestedBy: `${me.name} <${me.email}>`, format: cfg.provider === 'jira' ? 'wiki' : 'plain' });
  const summaryOverride = oneLine(req.body?.summary, 250);

  try {
    const created = await createTicket(cfg, { summary: summaryOverride || content.summary, description: content.description, priority });
    const ticketId = await transaction(async (client) => {
      const t = (
        await client.query(
          `INSERT INTO wk_tickets (tenant_id, provider, external_key, external_url, external_ref, summary, priority, reason, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [tenantId, cfg.provider, created.key, created.url, created.ref ?? null, (summaryOverride || content.summary).slice(0, 300), priority, reason, req.user!.userId]
        )
      ).rows[0].id;
      for (const id of ids) await client.query(`INSERT INTO wk_ticket_transactions (ticket_id, transaction_id) VALUES ($1,$2)`, [t, id]);
      return t;
    });
    await audit(req, { action: 'ticket.create', tenantId, target: `${cfg.provider}/${created.key}`, details: { documents: ids.length, priority } });
    await syncTicket(ticketId, tenantId); // first status and assignee; the worker keeps it current after that
    res.status(201).json({ id: ticketId, provider: cfg.provider, key: created.key, url: created.url });
  } catch (e) {
    if (e instanceof TicketError) {
      await audit(req, { action: 'ticket.create', tenantId, outcome: 'failure', details: { documents: ids.length } });
      return res.status(e.status).json({ error: e.message });
    }
    throw e;
  }
});

// ---------------------------------------------------------------- following tickets

const TICKET_COLS = `t.id, t.provider, t.external_key, t.external_url, t.summary, t.priority, t.external_priority, t.status, t.status_category,
              t.assignee, t.external_updated_at, t.synced_at, t.sync_error, t.created_at,
              COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), u.email) AS created_by_name`;

/** Tickets this organisation raised from the portal, newest first, with the documents they cover. */
router.get('/tickets', async (req, res) => {
  const open = req.query.state === 'open';
  const { rows } = await query(
    `SELECT ${TICKET_COLS},
            (SELECT COALESCE(json_agg(json_build_object('id', tr.id, 'type', tr.document_type, 'number', tr.business_number) ORDER BY tr.id), '[]'::json)
               FROM wk_ticket_transactions x JOIN wk_transactions tr ON tr.id = x.transaction_id WHERE x.ticket_id = t.id) AS documents
       FROM wk_tickets t LEFT JOIN wk_users u ON u.id = t.created_by
      WHERE t.tenant_id = $1 AND ($2::boolean IS FALSE OR COALESCE(t.status_category, 'open') <> 'done')
      ORDER BY t.created_at DESC LIMIT 200`,
    [tenantIdOf(req), open]
  );
  res.json({ tickets: rows });
});

async function ticketOf(req: Request) {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return queryOne<{ id: string; provider: string; external_key: string; external_ref: string | null }>(
    `SELECT id, provider, external_key, external_ref FROM wk_tickets WHERE id = $1 AND tenant_id = $2`, [id, tenantIdOf(req)]);
}

async function ticketDetail(tenantId: number, id: string) {
  const t = await queryOne(
    `SELECT ${TICKET_COLS}, t.reason,
            (SELECT COALESCE(json_agg(json_build_object('id', tr.id, 'type', tr.document_type, 'number', tr.business_number, 'status', tr.canonical_status) ORDER BY tr.id), '[]'::json)
               FROM wk_ticket_transactions x JOIN wk_transactions tr ON tr.id = x.transaction_id WHERE x.ticket_id = t.id) AS documents
       FROM wk_tickets t LEFT JOIN wk_users u ON u.id = t.created_by WHERE t.id = $1 AND t.tenant_id = $2`, [id, tenantId]);
  const comments = (await query(`SELECT id, author, body, source, created_at FROM wk_ticket_comments WHERE ticket_id = $1 ORDER BY created_at, id`, [id])).rows;
  return { ...(t as object), comments };
}

/** One ticket with its comments. ?refresh=1 reads the ticket system first, so opening a ticket shows its latest state. */
router.get('/tickets/:id', async (req, res) => {
  const t = await ticketOf(req);
  if (!t) return res.status(404).json({ error: 'Ticket not found.' });
  if (req.query.refresh === '1') await syncTicket(t.id, tenantIdOf(req));
  res.json(await ticketDetail(tenantIdOf(req), t.id));
});

router.post('/tickets/:id/refresh', async (req, res) => {
  const t = await ticketOf(req);
  if (!t) return res.status(404).json({ error: 'Ticket not found.' });
  if (!allowTicketWrite(`refresh:${tenantIdOf(req)}:${req.user!.userId}`)) return res.status(429).json({ error: 'Too many refreshes. Try again later.' });
  const r = await syncTicket(t.id, tenantIdOf(req));
  if (!r.ok) return res.status(502).json({ error: r.error });
  res.json(await ticketDetail(tenantIdOf(req), t.id));
});

/** A comment from the portal. It is written to the ticket system under the service account, signed with who wrote it. */
router.post('/tickets/:id/comments', async (req, res) => {
  const tenantId = tenantIdOf(req);
  const t = await ticketOf(req);
  if (!t) return res.status(404).json({ error: 'Ticket not found.' });
  const body = clean(req.body?.body, 4000);
  if (body.length < 2) return res.status(400).json({ error: 'Write a comment first.' });
  if (!allowTicketWrite(`comment:${tenantId}:${req.user!.userId}`)) return res.status(429).json({ error: 'Too many comments this hour.' });
  const cfg = await loadTicketConfig(tenantId);
  if (!cfg || cfg.provider !== t.provider) return res.status(409).json({ error: 'The ticket system for this ticket is not connected.' });

  const me = await whoIs(req);
  try {
    await addComment(cfg, { key: t.external_key, ref: t.external_ref }, `${PORTAL_COMMENT_MARK} ${me.name} (${me.email}):\n\n${body}`);
  } catch (e) {
    if (e instanceof TicketError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  await audit(req, { action: 'ticket.comment', tenantId, target: `${t.provider}/${t.external_key}` });
  await syncTicket(t.id, tenantId); // brings the comment back with its own id and time
  res.status(201).json(await ticketDetail(tenantId, t.id));
});

/** The status changes the ticket system allows right now (Jira workflows differ per project). */
router.get('/tickets/:id/transitions', async (req, res) => {
  const t = await ticketOf(req);
  if (!t) return res.status(404).json({ error: 'Ticket not found.' });
  const cfg = await loadTicketConfig(tenantIdOf(req));
  if (!cfg || cfg.provider !== t.provider) return res.json({ transitions: [], canChange: false });
  try {
    res.json({ transitions: await listTransitions(cfg, { key: t.external_key, ref: t.external_ref }), canChange: cfg.provider === 'jira' });
  } catch (e) {
    if (e instanceof TicketError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

router.post('/tickets/:id/transition', async (req, res) => {
  const tenantId = tenantIdOf(req);
  const t = await ticketOf(req);
  if (!t) return res.status(404).json({ error: 'Ticket not found.' });
  const transitionId = String(req.body?.transitionId ?? '');
  if (!allowTicketWrite(`transition:${tenantId}:${req.user!.userId}`)) return res.status(429).json({ error: 'Too many status changes this hour.' });
  const cfg = await loadTicketConfig(tenantId);
  if (!cfg || cfg.provider !== t.provider) return res.status(409).json({ error: 'The ticket system for this ticket is not connected.' });
  try {
    await transitionTicket(cfg, { key: t.external_key, ref: t.external_ref }, transitionId);
  } catch (e) {
    if (e instanceof TicketError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  await audit(req, { action: 'ticket.transition', tenantId, target: `${t.provider}/${t.external_key}`, details: { transitionId } });
  await syncTicket(t.id, tenantId);
  res.json(await ticketDetail(tenantId, t.id));
});

router.get('/transactions/:id/tickets', async (req, res) => {
  const { rows } = await query(
    `SELECT t.id, t.provider, t.external_key, t.external_url, t.priority, t.created_at, t.status, t.status_category
       FROM wk_tickets t JOIN wk_ticket_transactions x ON x.ticket_id = t.id
      WHERE t.tenant_id = $1 AND x.transaction_id = $2 ORDER BY t.created_at DESC LIMIT 20`,
    [tenantIdOf(req), Number(req.params.id)]
  );
  res.json({ tickets: rows });
});

// ---------------------------------------------------------------- emailed report

const EMAIL = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()"]+$/;

router.post('/reports/email', async (req, res) => {
  const tenantId = tenantIdOf(req);
  const ids = parseIds(req.body?.transactionIds);
  if (!ids) return res.status(400).json({ error: `Choose between 1 and ${MAX_DOCS} documents.` });

  const rawTo = Array.isArray(req.body?.to) ? req.body.to : typeof req.body?.to === 'string' ? req.body.to.split(/[,;\s]+/) : [];
  const to = [...new Set(rawTo.map((x: unknown) => clean(x, 254).toLowerCase()).filter(Boolean))] as string[];
  if (to.length === 0 || to.length > 5) return res.status(400).json({ error: 'Enter between 1 and 5 recipient email addresses.' });
  const badAddress = to.find((a) => !EMAIL.test(a));
  if (badAddress) return res.status(400).json({ error: `"${badAddress}" is not a valid email address.` });
  const subject = oneLine(req.body?.subject, 150);
  if (subject.length < 3) return res.status(400).json({ error: 'Enter a subject.' });
  const note = clean(req.body?.note, 2000) || null;

  const cfg = await brevoConfig(tenantId);
  if (!cfg) return res.status(409).json({ error: 'Email is not set up for this organisation. An administrator needs to save a Brevo key and sender address on the tenant page.' });
  if (!allowReport(`${tenantId}:${req.user!.userId}`)) return res.status(429).json({ error: 'That is a lot of reports in an hour. Try again later.' });

  const docs = await loadReportDocs(tenantId, ids);
  if (docs.length !== ids.length) return res.status(404).json({ error: 'One or more documents were not found.' });

  const me = await whoIs(req);
  const tenant = await queryOne<{ name: string }>(`SELECT name FROM wk_tenants WHERE id = $1`, [tenantId]);
  const { html, text } = buildReportEmail({ docs, subject, note, sentBy: me, tenantName: tenant?.name ?? 'EDI360' });

  // One message per recipient, so nobody sees who else it went to, and one failure does not hide the rest
  const results = await Promise.all(to.map((addr) => sendTenantEmail(tenantId, { to: addr, subject, html, text, replyTo: me.email ? { email: me.email, name: me.name } : undefined }, me.name ? `${me.name} via EDI Portal` : undefined)));
  const failed = results.map((r, i) => ({ to: to[i], error: r.error })).filter((r, i) => !results[i].sent);

  const status = failed.length === 0 ? 'sent' : failed.length === to.length ? 'failed' : 'partial';
  const log = await queryOne<{ id: string }>(
    `INSERT INTO wk_report_emails (tenant_id, sent_by, recipients, subject, documents, status, error) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [tenantId, req.user!.userId, to, subject, ids.length, status, failed.length ? failed.map((f) => `${f.to}: ${f.error}`).join('; ').slice(0, 500) : null]
  );
  for (const id of ids) await query(`INSERT INTO wk_report_email_transactions (report_id, transaction_id) VALUES ($1,$2)`, [log!.id, id]);
  await audit(req, { action: 'report.email', tenantId, outcome: status === 'failed' ? 'failure' : 'success', details: { documents: ids.length, recipients: to.length } });

  if (status === 'failed') return res.status(502).json({ error: failed[0].error ?? 'The email could not be sent', failed });
  res.json({ status, sent: to.length - failed.length, failed });
});

export default router;
