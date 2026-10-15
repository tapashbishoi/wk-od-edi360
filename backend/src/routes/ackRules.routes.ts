import { Router, type Request, type Response } from 'express';
import { query, queryOne } from '../db/connection.js';
import { authMiddleware, requireActiveTenant, requireTenantMember } from '../middleware/auth.middleware.js';
import { audit } from '../services/audit.service.js';
import { brevoConfig } from '../services/email.service.js';
import { findPending, runNow, type AckRule } from '../services/ackRule.service.js';

/**
 * /api/tenants/:tenantId/ack-rules - 997 reminder rules: email people when a partner's 997 has been
 * pending too long, on a schedule or on demand. Rules name recipients who may not be portal users, so
 * only administrators change them or send; support may look. Not email alert subscriptions.
 */
const router = Router({ mergeParams: true });
router.use(authMiddleware, requireActiveTenant, requireTenantMember);

const VIEW = ['platform_admin', 'customer_admin', 'support'];
const MANAGE = ['platform_admin', 'customer_admin'];
const MAX_RULES = 20;
const MAX_RECIPIENTS = 10;

router.use((req, res, next) => {
  const allowed = req.method === 'GET' ? VIEW : MANAGE;
  return allowed.includes(req.user?.role ?? '') ? next() : res.status(403).json({ error: 'Forbidden' });
});

const tenantIdOf = (req: Request) => Number(req.params.tenantId);
const EMAIL = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()"]+$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseRule(body: any): { ok: true; v: Omit<AckRule, 'id' | 'tenant_id' | 'is_active'> & { is_active?: boolean } } | { ok: false; error: string } {
  const name = typeof body?.name === 'string' ? body.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) : '';
  if (name.length < 3) return { ok: false, error: 'Give the rule a name (at least 3 characters).' };
  const partner = body?.partnerId ? String(body.partnerId).trim().slice(0, 40) : null;
  const direction = body?.direction ?? 'both';
  if (!['inbound', 'outbound', 'both'].includes(direction)) return { ok: false, error: 'Direction must be inbound, outbound or both.' };
  const hours = Number(body?.thresholdHours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) return { ok: false, error: 'Hours must be a whole number from 1 to 720.' };

  let types: string[] | null = null;
  if (Array.isArray(body?.documentTypes) && body.documentTypes.length) {
    types = [...new Set(body.documentTypes.map((x: unknown) => String(x).trim().toUpperCase()))] as string[];
    if (types.length > 20 || types.some((t) => !/^[A-Z0-9]{1,10}$/.test(t))) return { ok: false, error: 'Invalid document type.' };
  }

  const recipients = [...new Set((Array.isArray(body?.recipients) ? body.recipients : []).map((x: unknown) => String(x).trim().toLowerCase()).filter(Boolean))] as string[];
  if (recipients.length < 1) return { ok: false, error: 'Add at least one email address.' };
  if (recipients.length > MAX_RECIPIENTS) return { ok: false, error: `At most ${MAX_RECIPIENTS} recipients.` };
  const bad = recipients.find((a) => !EMAIL.test(a) || a.length > 200);
  if (bad) return { ok: false, error: `"${bad.slice(0, 60)}" is not a valid email address.` };

  const times = [...new Set((Array.isArray(body?.sendTimes) ? body.sendTimes : []).map((x: unknown) => String(x).trim()))] as string[];
  if (times.length > 4) return { ok: false, error: 'At most 4 send times a day.' };
  const badTime = times.find((t) => !TIME.test(t));
  if (badTime) return { ok: false, error: `"${badTime.slice(0, 20)}" is not a time. Use HH:MM, e.g. 08:00.` };

  return { ok: true, v: { name, partner_id: partner, document_types: types, direction, threshold_hours: hours, recipients, send_times: times.sort(), is_active: typeof body?.isActive === 'boolean' ? body.isActive : undefined } };
}

const COLS = `id, tenant_id, name, partner_id, document_types, direction, threshold_hours, recipients, send_times, is_active, last_run_at, last_run_status, last_run_count, created_at`;

async function loadRule(req: Request): Promise<AckRule | null> {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return null;
  return queryOne<AckRule>(`SELECT ${COLS} FROM wk_ack_rules WHERE id = $1 AND tenant_id = $2`, [id, tenantIdOf(req)]);
}

router.get('/', async (req, res) => {
  const tenantId = tenantIdOf(req);
  const [rules, cfg, tz] = await Promise.all([
    query(
      `SELECT ${COLS},
              (SELECT MAX(CASE t.direction WHEN 'inbound' THEN t.sender_name ELSE t.receiver_name END) FROM wk_transactions t
                WHERE t.tenant_id = r.tenant_id AND r.partner_id IS NOT NULL AND (CASE t.direction WHEN 'inbound' THEN t.sender_id ELSE t.receiver_id END) = r.partner_id) AS partner_name
         FROM wk_ack_rules r WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]),
    brevoConfig(tenantId),
    queryOne<{ timezone: string }>(`SELECT timezone FROM wk_tenants WHERE id = $1`, [tenantId]),
  ]);
  res.json({ emailConfigured: !!cfg, timezone: tz?.timezone ?? 'UTC', rules: rules.rows });
});

router.post('/', async (req: Request, res: Response) => {
  const tenantId = tenantIdOf(req);
  const p = parseRule(req.body);
  if (!p.ok) return res.status(400).json({ error: p.error });
  const n = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM wk_ack_rules WHERE tenant_id = $1`, [tenantId]);
  if ((n?.n ?? 0) >= MAX_RULES) return res.status(400).json({ error: `At most ${MAX_RULES} rules per organisation.` });
  const v = p.v;
  const row = await queryOne(
    `INSERT INTO wk_ack_rules (tenant_id, name, partner_id, document_types, direction, threshold_hours, recipients, send_times, is_active, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${COLS}`,
    [tenantId, v.name, v.partner_id, v.document_types, v.direction, v.threshold_hours, v.recipients, v.send_times, v.is_active ?? true, req.user!.userId === 'api-key' ? null : req.user!.userId]
  );
  await audit(req, { action: 'ackrule.create', tenantId, target: v.name, details: { recipients: v.recipients.length, hours: v.threshold_hours } });
  res.status(201).json(row);
});

router.put('/:id', async (req, res) => {
  const rule = await loadRule(req);
  if (!rule) return res.status(404).json({ error: 'Rule not found.' });
  const p = parseRule(req.body);
  if (!p.ok) return res.status(400).json({ error: p.error });
  const v = p.v;
  const row = await queryOne(
    `UPDATE wk_ack_rules SET name=$3, partner_id=$4, document_types=$5, direction=$6, threshold_hours=$7, recipients=$8, send_times=$9, is_active=COALESCE($10, is_active)
      WHERE id = $1 AND tenant_id = $2 RETURNING ${COLS}`,
    [rule.id, rule.tenant_id, v.name, v.partner_id, v.document_types, v.direction, v.threshold_hours, v.recipients, v.send_times, v.is_active ?? null]
  );
  await audit(req, { action: 'ackrule.update', tenantId: rule.tenant_id, target: v.name });
  res.json(row);
});

router.patch('/:id', async (req, res) => {
  if (typeof req.body?.isActive !== 'boolean') return res.status(400).json({ error: 'Nothing to change.' });
  const row = await queryOne(`UPDATE wk_ack_rules SET is_active = $3 WHERE id = $1 AND tenant_id = $2 RETURNING id, is_active`, [Number(req.params.id) || 0, tenantIdOf(req), req.body.isActive]);
  if (!row) return res.status(404).json({ error: 'Rule not found.' });
  await audit(req, { action: 'ackrule.toggle', tenantId: tenantIdOf(req), target: String(req.params.id), details: { active: req.body.isActive } });
  res.json(row);
});

router.delete('/:id', async (req, res) => {
  const rule = await loadRule(req);
  if (!rule) return res.status(404).json({ error: 'Rule not found.' });
  await query(`DELETE FROM wk_ack_rules WHERE id = $1 AND tenant_id = $2`, [rule.id, rule.tenant_id]);
  await audit(req, { action: 'ackrule.delete', tenantId: rule.tenant_id, target: rule.name });
  res.status(204).end();
});

/** What the rule would report right now. Sends nothing. */
router.get('/:id/preview', async (req, res) => {
  const rule = await loadRule(req);
  if (!rule) return res.status(404).json({ error: 'Rule not found.' });
  const docs = await findPending(rule);
  res.json({ total: docs.length, documents: docs.slice(0, 50) });
});

router.get('/:id/runs', async (req, res) => {
  const rule = await loadRule(req);
  if (!rule) return res.status(404).json({ error: 'Rule not found.' });
  const { rows } = await query(
    `SELECT id, trigger_kind, slot, pending_count, sent, failed, status, error, created_at FROM wk_ack_rule_runs WHERE rule_id = $1 ORDER BY created_at DESC LIMIT 10`, [rule.id]);
  res.json(rows);
});

// On demand: re-checks with Orderful, then mails the recipients. Limited so it cannot be used to spam them.
const lastRun = new Map<number, number>();
const userRuns = new Map<string, number[]>();

router.post('/:id/run', async (req, res) => {
  const rule = await loadRule(req);
  if (!rule) return res.status(404).json({ error: 'Rule not found.' });
  if (!(await brevoConfig(rule.tenant_id))) return res.status(400).json({ error: 'Email is not set up for this organisation (save a Brevo key and sender address first).' });

  const now = Date.now();
  if (now - (lastRun.get(rule.id) ?? 0) < 60_000) return res.status(429).json({ error: 'This rule just ran. Wait a minute.' });
  const mine = (userRuns.get(req.user!.userId) ?? []).filter((t) => now - t < 3_600_000);
  if (mine.length >= 10) return res.status(429).json({ error: 'Too many manual runs this hour.' });
  lastRun.set(rule.id, now);
  userRuns.set(req.user!.userId, [...mine, now]);

  const result = await runNow(rule, req.user!.userId === 'api-key' ? null : req.user!.userId);
  await audit(req, { action: 'ackrule.run', tenantId: rule.tenant_id, target: rule.name, outcome: result.status === 'failed' ? 'failure' : 'success', details: { pending: result.pending, sent: result.sent } });
  res.json(result);
});

export default router;
