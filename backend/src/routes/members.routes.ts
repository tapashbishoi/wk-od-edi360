import { Router, type Request } from 'express';
import { query, queryOne } from '../db/connection.js';
import { authMiddleware, clearUserAccessCache, requireActiveTenant, requireTenantAccess } from '../middleware/auth.middleware.js';
import { audit } from '../services/audit.service.js';
import { brevoConfig, sendTenantEmail } from '../services/email.service.js';
import {
  MEMBER_ROLES, ROLE_DESCRIPTION, createInvitation, inviteEmail, inviteUrl, isMemberRole, listMembers, normalizeEmail,
} from '../services/members.service.js';

/**
 * /api/admin/tenants/:tenantId/members
 *
 * Platform admins manage any tenant's members; a customer admin only its own
 * (requireTenantAccess). Every query is scoped by the tenant in the path AND the
 * member's tenant_id, so an id from another tenant is a 404, not a hole.
 */
const router = Router({ mergeParams: true });
// requireActiveTenant first: it refreshes the role from the database, which requireTenantAccess then checks
router.use(authMiddleware, requireActiveTenant, requireTenantAccess);

/** The tenant in the path. Typed through Request because mergeParams params are not visible to per-route typing. */
const tenantIdOf = (req: Request) => Number(req.params.tenantId);

const name = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : null);

/** Sends the invitation email when the tenant has Brevo set up. Never throws. */
async function deliverInvite(tenantId: number, to: string, firstName: string | null, url: string, invitedBy: string) {
  const tenant = await queryOne<{ name: string }>(`SELECT name FROM wk_tenants WHERE id = $1`, [tenantId]);
  const mail = inviteEmail({ tenantName: tenant?.name ?? 'your organisation', firstName, url, invitedBy });
  return sendTenantEmail(tenantId, { ...mail, to, toName: firstName ?? undefined });
}

router.get('/', async (req, res) => {
  const tenantId = tenantIdOf(req);
  res.json({
    members: await listMembers(tenantId),
    roles: MEMBER_ROLES.map((r) => ({ role: r, description: ROLE_DESCRIPTION[r] })),
    emailConfigured: !!(await brevoConfig(tenantId)),
  });
});

router.post('/', async (req, res) => {
  const tenantId = tenantIdOf(req);
  const email = normalizeEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'A valid email address is required' });
  if (!isMemberRole(req.body?.role)) return res.status(400).json({ error: `Role must be one of: ${MEMBER_ROLES.join(', ')}` });

  const tenant = await queryOne<{ status: string }>(`SELECT status FROM wk_tenants WHERE id = $1`, [tenantId]);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  if (tenant.status === 'offboarded') return res.status(409).json({ error: 'This tenant has been offboarded' });

  const firstName = name(req.body?.firstName);
  const lastName = name(req.body?.lastName);

  let userId: string;
  try {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO wk_users (email, role, tenant_id, first_name, last_name) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [email, req.body.role, tenantId, firstName, lastName]
    );
    userId = row!.id;
  } catch (error: any) {
    // Same answer whether the address belongs to this tenant or another: it must not reveal who else uses the portal
    if (error.code === '23505') return res.status(409).json({ error: 'That email address is already in use' });
    throw error;
  }

  const { token, expiresAt } = await createInvitation(tenantId, userId, req.user!.userId);
  const url = inviteUrl(token);
  const mail = await deliverInvite(tenantId, email, firstName, url, req.user!.email);

  await audit(req, { action: 'member.add', tenantId, target: email, details: { role: req.body.role, emailed: mail.sent } });
  const members = await listMembers(tenantId);
  res.status(201).json({
    member: members.find((m) => m.id === userId),
    // The link is shown to the admin whether or not the email went out, so a member is never stranded
    inviteUrl: url,
    inviteExpiresAt: expiresAt,
    emailed: mail.sent,
    emailError: mail.sent ? undefined : mail.error,
  });
});

router.patch('/:userId', async (req, res) => {
  const tenantId = tenantIdOf(req);
  const target = await queryOne<{ id: string; email: string; role: string; is_active: boolean }>(
    `SELECT id, email, role, is_active FROM wk_users WHERE id::text = $1 AND tenant_id = $2`,
    [req.params.userId, tenantId]
  );
  if (!target) return res.status(404).json({ error: 'Member not found' });

  const { role, isActive } = req.body ?? {};
  if (role !== undefined && !isMemberRole(role)) return res.status(400).json({ error: `Role must be one of: ${MEMBER_ROLES.join(', ')}` });
  if (isActive !== undefined && typeof isActive !== 'boolean') return res.status(400).json({ error: 'isActive must be true or false' });

  const losesAdmin = target.role === 'customer_admin' && ((role !== undefined && role !== 'customer_admin') || isActive === false);
  if (losesAdmin) {
    if (target.id === req.user!.userId) return res.status(400).json({ error: "You can't remove your own admin access" });
    // Never strand a tenant with nobody able to manage it (a platform admin can still do it deliberately)
    if (req.user!.role !== 'platform_admin') {
      const others = await queryOne<{ n: string }>(
        `SELECT COUNT(*) AS n FROM wk_users WHERE tenant_id = $1 AND role = 'customer_admin' AND is_active AND id <> $2`,
        [tenantId, target.id]
      );
      if (Number(others?.n) === 0) return res.status(409).json({ error: 'A tenant needs at least one active administrator' });
    }
  }

  await query(
    `UPDATE wk_users SET role = COALESCE($3, role), is_active = COALESCE($4, is_active),
            first_name = COALESCE($5, first_name), last_name = COALESCE($6, last_name)
      WHERE id = $1 AND tenant_id = $2`,
    [target.id, tenantId, role ?? null, isActive ?? null, name(req.body?.firstName), name(req.body?.lastName)]
  );

  clearUserAccessCache(target.id); // a disabled account or new role takes effect now, not after the cache expires
  await audit(req, { action: 'member.update', tenantId, target: target.email, details: { role, isActive } });
  res.json({ member: (await listMembers(tenantId)).find((m) => m.id === target.id) });
});

/**
 * New invitation link for an existing member: resends a lost invite, or lets a member
 * who forgot their password set a new one. The previous unused link stops working.
 * (An existing password keeps working until the new link is used.)
 */
router.post('/:userId/invite', async (req, res) => {
  const tenantId = tenantIdOf(req);
  const target = await queryOne<{ id: string; email: string; first_name: string | null; is_active: boolean }>(
    `SELECT id, email, first_name, is_active FROM wk_users WHERE id::text = $1 AND tenant_id = $2`,
    [req.params.userId, tenantId]
  );
  if (!target) return res.status(404).json({ error: 'Member not found' });
  if (!target.is_active) return res.status(409).json({ error: 'Re-enable this member before sending a link' });

  const { token, expiresAt } = await createInvitation(tenantId, target.id, req.user!.userId);
  const url = inviteUrl(token);
  const mail = await deliverInvite(tenantId, target.email, target.first_name, url, req.user!.email);

  await audit(req, { action: 'member.invite', tenantId, target: target.email, details: { emailed: mail.sent } });
  res.json({ inviteUrl: url, inviteExpiresAt: expiresAt, emailed: mail.sent, emailError: mail.sent ? undefined : mail.error });
});

export default router;
