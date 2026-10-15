import { normalizeView } from '../utils/savedView.js';
import { Router } from 'express';
import { query } from '../db/connection.js';
import { AuthService } from '../services/auth.service.js';
import { audit } from '../services/audit.service.js';
import { authMiddleware, TENANT_BLOCKED } from '../middleware/auth.middleware.js';
import { InviteError, acceptInvitation, lookupInvitation } from '../services/members.service.js';

const router = Router();

// Verified against when the email is unknown, so "no such user" costs the same as
// "wrong password" and response time does not reveal which accounts exist.
const dummyHash = AuthService.hashPassword("not-a-real-password");

router.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const { rows } = await query(
    `SELECT u.id, u.email, u.password_hash, u.role, u.tenant_id, t.status AS tenant_status
       FROM wk_users u LEFT JOIN wk_tenants t ON t.id = u.tenant_id
      WHERE lower(u.email) = lower($1) AND u.is_active`,
    [email]
  );
  const user = rows[0];
  // A member who has not yet accepted their invitation has no password hash, which never matches
  const ok = await AuthService.verifyPassword(password, user?.password_hash ?? (await dummyHash));

  if (!user || !ok) {
    await audit(null, { action: 'auth.login', outcome: 'failure', target: email });
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Said only AFTER the password was right, so it can't be used to probe which organisations exist
  if (user.tenant_status && TENANT_BLOCKED.includes(user.tenant_status)) {
    await audit(null, { action: 'auth.login', tenantId: user.tenant_id, outcome: 'failure', target: user.email, details: { reason: `tenant ${user.tenant_status}` } });
    return res.status(403).json({ error: 'Your organisation is not currently active. Contact your administrator.' });
  }

  await query(`UPDATE wk_users SET last_login = NOW() WHERE id = $1`, [user.id]);
  const token = AuthService.generateAccessToken({
    userId: user.id,
    email: user.email,
    role: user.role,
    tenantId: user.tenant_id,
  });
  await audit(null, { action: 'auth.login', tenantId: user.tenant_id, target: user.email });

  res.json({ token, user: { id: user.id, email: user.email, role: user.role, tenantId: user.tenant_id } });
});

const GONE = 'This invitation link is no longer valid. Ask your administrator for a new one.';

/** What an invitation link is for, so the page can greet the person. Nothing here is a secret. */
router.get('/invite/:token', async (req, res) => {
  const info = await lookupInvitation(req.params.token);
  // Unknown, replaced and expired all look the same from outside
  if (!info || info.state !== 'valid') return res.status(410).json({ error: GONE });
  res.json({ email: info.email, firstName: info.firstName, tenantName: info.tenantName });
});

/** Sets the password from an invitation and signs the member in. */
router.post('/accept-invite', async (req, res) => {
  try {
    const user = await acceptInvitation(String(req.body?.token ?? ''), req.body?.password);
    const token = AuthService.generateAccessToken({ userId: user.id, email: user.email, role: user.role, tenantId: user.tenant_id });
    await query(`UPDATE wk_users SET last_login = NOW() WHERE id = $1`, [user.id]);
    await audit(null, { action: 'member.accept', tenantId: user.tenant_id, target: user.email });
    res.json({ token });
  } catch (error) {
    if (error instanceof InviteError) return res.status(error.status).json({ error: error.message });
    throw error;
  }
});

/** The signed-in user and their tenant, read fresh so a role or status change shows without re-login. */
router.get('/me', authMiddleware, async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.tenant_id, u.is_active,
            t.name AS tenant_name, t.slug AS tenant_slug, t.status AS tenant_status,
            t.timezone AS tenant_timezone, t.raw_edi_enabled, u.saved_view
       FROM wk_users u LEFT JOIN wk_tenants t ON t.id = u.tenant_id WHERE u.id = $1`,
    [req.user!.userId]
  );
  const u = rows[0];
  // A deactivated account's token stays valid until it expires; this is where that is caught
  if (!u || !u.is_active) return res.status(401).json({ error: 'Account is no longer active' });

  res.json({
    user: {
      id: u.id,
      email: u.email,
      firstName: u.first_name,
      lastName: u.last_name,
      role: u.role,
      tenantId: u.tenant_id,
      savedView: u.saved_view ?? [],
      tenant: u.tenant_id
        ? { id: u.tenant_id, name: u.tenant_name, slug: u.tenant_slug, status: u.tenant_status, timezone: u.tenant_timezone, rawEdiEnabled: u.raw_edi_enabled }
        : null,
    },
  });
});

/** Saves the caller's own My View. Only ever the caller's: there is no way to set another user's. */
router.put('/me/saved-view', authMiddleware, async (req, res) => {
  if (!Array.isArray(req.body?.savedView)) return res.status(400).json({ error: 'savedView must be an array' });
  const savedView = normalizeView(req.body.savedView);
  await query(`UPDATE wk_users SET saved_view = $2::jsonb WHERE id = $1`, [req.user!.userId, JSON.stringify(savedView)]);
  res.json({ savedView });
});

export default router;
