import { Router, type Request, type Response } from 'express';
import { query, queryOne } from '../db/connection.js';
import { authMiddleware, requireActiveTenant, requireTenantMember } from '../middleware/auth.middleware.js';
import { audit } from '../services/audit.service.js';
import { brevoConfig, escapeHtml, sendTenantEmail } from '../services/email.service.js';

/**
 * /api/tenants/:tenantId/alerts - the caller's own email alert subscriptions. Everyone in the tenant
 * may subscribe (an alert shows what the portal already shows them). A subscription is only ever
 * read or changed by the user who made it.
 */
const router = Router({ mergeParams: true });
router.use(authMiddleware, requireActiveTenant, requireTenantMember);

const tenantIdOf = (req: Request) => Number(req.params.tenantId);
const userIdOf = (req: Request) => req.user!.userId;

const TRIGGERS = ['success', 'failure', 'both'];

router.get('/', async (req, res) => {
  const tenantId = tenantIdOf(req);
  const [subs, cfg] = await Promise.all([
    query(
      `SELECT s.id, s.partner_id, s.document_type, s.trigger_event, s.email, s.is_active, s.created_at,
              (SELECT MAX(p.name) FROM (SELECT CASE t.direction WHEN 'inbound' THEN t.sender_name ELSE t.receiver_name END AS name,
                                               CASE t.direction WHEN 'inbound' THEN t.sender_id ELSE t.receiver_id END AS pid
                                          FROM wk_transactions t WHERE t.tenant_id = s.tenant_id) p WHERE p.pid = s.partner_id) AS partner_name,
              (SELECT COUNT(*)::int FROM wk_alert_dispatches d WHERE d.subscription_id = s.id AND d.status = 'sent') AS sent,
              (SELECT COUNT(*)::int FROM wk_alert_dispatches d WHERE d.subscription_id = s.id AND d.status IN ('failed','given_up')) AS failed
         FROM wk_alert_subscriptions s WHERE s.tenant_id = $1 AND s.user_id = $2 ORDER BY s.created_at DESC`,
      [tenantId, userIdOf(req)]
    ),
    brevoConfig(tenantId),
  ]);
  res.json({ emailConfigured: !!cfg, subscriptions: subs.rows });
});

router.post('/', async (req: Request, res: Response) => {
  const tenantId = tenantIdOf(req);
  const partnerId = req.body?.partnerId ? String(req.body.partnerId).trim().slice(0, 40) : null;
  const documentType = req.body?.documentType ? String(req.body.documentType).trim().toUpperCase() : null;
  const trigger = String(req.body?.trigger ?? 'failure');
  if (!TRIGGERS.includes(trigger)) return res.status(400).json({ error: 'Choose success, failure or both.' });
  if (documentType && !/^[A-Z0-9]{1,10}$/.test(documentType)) return res.status(400).json({ error: 'Invalid document type.' });

  const user = await queryOne<{ email: string }>(`SELECT email FROM wk_users WHERE id = $1`, [userIdOf(req)]);
  if (!user) return res.status(401).json({ error: 'Account not found' });
  try {
    const row = await queryOne(
      `INSERT INTO wk_alert_subscriptions (tenant_id, user_id, partner_id, document_type, trigger_event, email)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, partner_id, document_type, trigger_event, email, is_active`,
      [tenantId, userIdOf(req), partnerId, documentType, trigger, user.email]
    );
    await audit(req, { action: 'alert.subscribe', tenantId, target: `${partnerId ?? '*'}:${documentType ?? '*'}` });
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.code === '23505') return res.status(409).json({ error: 'You already have an alert for that partner and document type. Edit it instead.' });
    throw e;
  }
});

router.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const { isActive, trigger } = req.body ?? {};
  if (trigger !== undefined && !TRIGGERS.includes(trigger)) return res.status(400).json({ error: 'Choose success, failure or both.' });
  if (typeof isActive !== 'boolean' && trigger === undefined) return res.status(400).json({ error: 'Nothing to change.' });
  const row = await queryOne(
    `UPDATE wk_alert_subscriptions SET is_active = COALESCE($4, is_active), trigger_event = COALESCE($5, trigger_event)
      WHERE id = $1 AND tenant_id = $2 AND user_id = $3 RETURNING id, is_active, trigger_event`,
    [id, tenantIdOf(req), userIdOf(req), typeof isActive === 'boolean' ? isActive : null, trigger ?? null]
  );
  if (!row) return res.status(404).json({ error: 'Alert not found.' });
  res.json(row);
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const r = await query(`DELETE FROM wk_alert_subscriptions WHERE id = $1 AND tenant_id = $2 AND user_id = $3`, [id, tenantIdOf(req), userIdOf(req)]);
  if (!r.rowCount) return res.status(404).json({ error: 'Alert not found.' });
  res.status(204).end();
});

// A test mail goes only to the caller's own address, never one supplied in the request, and not
// more than a few a minute: it must not be usable to send mail to arbitrary people.
const lastTest = new Map<string, number>();

router.post('/test', async (req, res) => {
  const tenantId = tenantIdOf(req);
  const key = `${tenantId}:${userIdOf(req)}`;
  if (Date.now() - (lastTest.get(key) ?? 0) < 15_000) return res.status(429).json({ error: 'Wait a few seconds before sending another test.' });
  lastTest.set(key, Date.now());

  const user = await queryOne<{ email: string }>(`SELECT email FROM wk_users WHERE id = $1`, [userIdOf(req)]);
  if (!user) return res.status(401).json({ error: 'Account not found' });
  const result = await sendTenantEmail(tenantId, {
    to: user.email,
    subject: '[EDI] Test alert from EDI360',
    html: `<p style="font-family:Arial,sans-serif">This is a test. If you can read it, email alerts for <b>${escapeHtml(user.email)}</b> will arrive.</p>`,
    text: 'This is a test. If you can read it, email alerts will arrive.',
  });
  await audit(req, { action: 'alert.test', tenantId, outcome: result.sent ? 'success' : 'failure' });
  res.status(result.sent ? 200 : 502).json(result.sent ? { sent: true, to: user.email } : { sent: false, error: result.error });
});

export default router;
