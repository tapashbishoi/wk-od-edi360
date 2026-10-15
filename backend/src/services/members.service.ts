import crypto from 'crypto';
import { env } from '../config/env.js';
import { query, queryOne, transaction } from '../db/connection.js';
import { AuthService } from './auth.service.js';
import { escapeHtml, type Email } from './email.service.js';
import { validatePassword } from '../utils/password.js';

/**
 * Tenant members and their invitations.
 *
 * A member is created without a password and gets a single-use link. The link's
 * token is 256 bits of randomness; only its SHA-256 is stored. Accepting it sets
 * the password. Re-inviting (resend, or a password reset for an existing member)
 * replaces any earlier unused link, so only the newest one ever works.
 */

export const MEMBER_ROLES = ['customer_admin', 'support', 'business', 'auditor'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const ROLE_DESCRIPTION: Record<MemberRole, string> = {
  customer_admin: 'Manages members, credentials and settings. Sees everything, including raw EDI.',
  support: 'Investigates transactions. Sees business data and raw EDI.',
  business: 'Sees dashboards and business data. No raw EDI, no settings.',
  auditor: 'Read-only view of dashboards and business data.',
};

export const isMemberRole = (v: unknown): v is MemberRole => typeof v === 'string' && (MEMBER_ROLES as readonly string[]).includes(v);

export const INVITE_TTL_DAYS = 7;

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
export const inviteUrl = (token: string) => `${env.PORTAL_URL.replace(/\/+$/, '')}/invite/${token}`;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const normalizeEmail = (v: unknown): string | null => (typeof v === 'string' && EMAIL.test(v.trim()) && v.trim().length <= 255 ? v.trim().toLowerCase() : null);

/** Creates a fresh invitation for a user, replacing any unused one. Returns the raw token, shown once. */
export async function createInvitation(tenantId: number, userId: string, createdBy: string | null): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400000);
  await transaction(async (client) => {
    await client.query(`DELETE FROM wk_invitations WHERE user_id = $1 AND accepted_at IS NULL`, [userId]);
    await client.query(
      `INSERT INTO wk_invitations (tenant_id, user_id, token_hash, created_by, expires_at) VALUES ($1,$2,$3,$4,$5)`,
      [tenantId, userId, hashToken(token), createdBy, expiresAt]
    );
  });
  return { token, expiresAt };
}

export interface InvitationInfo {
  invitationId: number;
  userId: string;
  tenantId: number;
  email: string;
  firstName: string | null;
  tenantName: string;
  tenantStatus: string;
  state: 'valid' | 'expired' | 'used';
}

/** What a link points at. Null for a token that was never issued (or was replaced). */
export async function lookupInvitation(token: string): Promise<InvitationInfo | null> {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const row = await queryOne<any>(
    `SELECT i.id, i.user_id, i.tenant_id, i.expires_at, i.accepted_at, u.email, u.first_name, u.is_active, t.name AS tenant_name, t.status AS tenant_status
       FROM wk_invitations i JOIN wk_users u ON u.id = i.user_id JOIN wk_tenants t ON t.id = i.tenant_id
      WHERE i.token_hash = $1`,
    [hashToken(token)]
  );
  if (!row) return null;
  return {
    invitationId: row.id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    email: row.email,
    firstName: row.first_name,
    tenantName: row.tenant_name,
    tenantStatus: row.tenant_status,
    state: row.accepted_at ? 'used' : new Date(row.expires_at) < new Date() ? 'expired' : 'valid',
  };
}

export class InviteError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Sets the member's password and uses up the link, atomically. Returns the user to sign in. */
export async function acceptInvitation(token: string, password: unknown) {
  const info = await lookupInvitation(token);
  // One message for unknown, replaced, and expired: telling them apart would confirm which links ever existed
  if (!info || info.state !== 'valid') throw new InviteError(410, 'This invitation link is no longer valid. Ask your administrator for a new one.');
  if (['suspended', 'offboarded'].includes(info.tenantStatus)) throw new InviteError(403, 'This organisation is not currently active.');

  const problem = validatePassword(password, info.email);
  if (problem) throw new InviteError(400, problem);

  const hash = await AuthService.hashPassword(password as string);
  await transaction(async (client) => {
    // Re-checked under lock so two submissions of the same link cannot both win
    const claimed = await client.query(
      `UPDATE wk_invitations SET accepted_at = NOW() WHERE id = $1 AND accepted_at IS NULL AND expires_at > NOW() RETURNING id`,
      [info.invitationId]
    );
    if (claimed.rowCount === 0) throw new InviteError(410, 'This invitation link is no longer valid. Ask your administrator for a new one.');
    await client.query(`UPDATE wk_users SET password_hash = $2, is_active = true WHERE id = $1`, [info.userId, hash]);
  });

  const user = await queryOne<any>(`SELECT id, email, role, tenant_id FROM wk_users WHERE id = $1`, [info.userId]);
  return user as { id: string; email: string; role: MemberRole; tenant_id: number };
}

export function inviteEmail(opts: { tenantName: string; firstName?: string | null; url: string; invitedBy?: string }): Email & { to: '' } {
  const name = opts.firstName ? escapeHtml(opts.firstName) : 'there';
  const tenant = escapeHtml(opts.tenantName);
  const by = opts.invitedBy ? ` ${escapeHtml(opts.invitedBy)} has invited you to` : ' You have been invited to';
  return {
    to: '',
    subject: `You've been invited to ${opts.tenantName} on EDI360`,
    html:
      `<p>Hi ${name},</p>` +
      `<p>${by.trim()} follow <strong>${tenant}</strong>'s EDI transactions on EDI360.</p>` +
      `<p><a href="${escapeHtml(opts.url)}">Set your password and sign in</a></p>` +
      `<p style="color:#6b7280;font-size:12px">This link works once and expires in ${INVITE_TTL_DAYS} days. If you weren't expecting it, you can ignore this email.</p>`,
    text: `Hi ${opts.firstName ?? 'there'},\n\nYou have been invited to ${opts.tenantName} on EDI360.\nSet your password and sign in: ${opts.url}\n\nThis link works once and expires in ${INVITE_TTL_DAYS} days.`,
  };
}

export async function listMembers(tenantId: number) {
  const { rows } = await query(
    `SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.is_active, u.last_login, u.created_at,
            (u.password_hash IS NOT NULL) AS has_password,
            (SELECT i.expires_at FROM wk_invitations i WHERE i.user_id = u.id AND i.accepted_at IS NULL ORDER BY i.created_at DESC LIMIT 1) AS invite_expires_at
       FROM wk_users u WHERE u.tenant_id = $1 ORDER BY lower(u.email)`,
    [tenantId]
  );
  return rows.map((r: any) => ({
    id: r.id,
    email: r.email,
    firstName: r.first_name,
    lastName: r.last_name,
    role: r.role,
    isActive: r.is_active,
    lastLogin: r.last_login,
    createdAt: r.created_at,
    // invited = no password yet; disabled = switched off; else active
    status: !r.is_active ? 'disabled' : r.has_password ? 'active' : 'invited',
    inviteExpiresAt: r.invite_expires_at,
  }));
}
