import { Request, Response, NextFunction } from 'express';
import { AuthService, JWTPayload } from '../services/auth.service.js';
import { query } from '../db/connection.js';
import { logger } from '../utils/logger.js';

declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
      /** Set by apiKeyAuthMiddleware: the tenant that owns the presented key. */
      tenantId?: number;
      /** Set with tenantId: which key was presented (for the activity log) */
      apiKeyId?: string;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }
  const payload = AuthService.verifyAccessToken(header.slice(7));
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });

  req.user = payload;
  next();
}

export function platformAdminOnly(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== 'platform_admin') {
    return res.status(403).json({ error: 'Forbidden: platform admin access required' });
  }
  next();
}

/**
 * The :tenantId in the path must be the caller's own tenant (platform admins
 * excepted). Role checks alone are not enough where the tenant is named in the
 * URL: without this a customer_admin could read or change any other tenant.
 * The refusal is identical to the role refusal so it doesn't confirm that a
 * tenant id exists.
 */
export function requireTenantAccess(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role === 'platform_admin') return next();

  const requested = Number(req.params.tenantId);
  if (!Number.isInteger(requested)) return res.status(400).json({ error: 'Invalid tenant id' });

  if (req.user?.role !== 'customer_admin' || requested !== req.user.tenantId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// A member's standing - active, role, and their tenant's status - is read from the database per
// request, briefly cached, instead of being trusted from the token. Tokens last hours; a disabled
// account, a role change or a suspended tenant has to bite within seconds. Changes clear the
// relevant entries at once (below); the TTL bounds any other drift.
const ACCESS_TTL_MS = 15000;
interface AccessEntry {
  active: boolean;
  role: string;
  tenantId: number;
  tenantStatus: string;
  at: number;
}
const accessCache = new Map<string, AccessEntry>();

/** Forget one member (their role or active flag just changed). */
export function clearUserAccessCache(userId: string) {
  accessCache.delete(userId);
}

/** Forget every member of a tenant (its status just changed), or everyone. */
export function clearTenantStatusCache(tenantId?: number) {
  if (tenantId === undefined) return accessCache.clear();
  for (const [userId, e] of accessCache) if (e.tenantId === tenantId) accessCache.delete(userId);
}

export const TENANT_BLOCKED = ['suspended', 'offboarded'];

/**
 * Gate for every tenant member's request: the account must still be active and the tenant
 * not suspended/offboarded, and the role used downstream is the database's, not the token's.
 * Platform admins are never blocked - they are the ones who suspend and restore.
 * Must run BEFORE any role check (requireTenantAccess/Member), so those see the current role.
 */
export async function requireActiveTenant(req: Request, res: Response, next: NextFunction) {
  const user = req.user;
  if (!user || user.role === 'platform_admin' || !user.tenantId) return next();

  let entry = accessCache.get(user.userId);
  if (!entry || Date.now() - entry.at > ACCESS_TTL_MS) {
    const { rows } = await query(
      `SELECT u.is_active, u.role, u.tenant_id, t.status FROM wk_users u JOIN wk_tenants t ON t.id = u.tenant_id WHERE u.id = $1`,
      [user.userId]
    );
    const r = rows[0];
    entry = r
      ? { active: r.is_active, role: r.role, tenantId: r.tenant_id, tenantStatus: r.status, at: Date.now() }
      : { active: false, role: user.role, tenantId: user.tenantId, tenantStatus: 'offboarded', at: Date.now() };
    accessCache.set(user.userId, entry);
  }

  if (!entry.active) return res.status(401).json({ error: 'Your account is no longer active.' });
  if (TENANT_BLOCKED.includes(entry.tenantStatus)) {
    return res.status(403).json({ error: 'Your organisation is not currently active. Contact your administrator.' });
  }

  req.user = { ...user, role: entry.role as typeof user.role, tenantId: entry.tenantId };
  next();
}

/**
 * Read access to a tenant's data: any role belonging to that tenant, or a
 * platform admin (whose reads the routes audit). Same identical-refusal rule as
 * requireTenantAccess.
 */
export function requireTenantMember(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role === 'platform_admin') return next();

  const requested = Number(req.params.tenantId);
  if (!Number.isInteger(requested)) return res.status(400).json({ error: 'Invalid tenant id' });
  if (requested !== req.user?.tenantId) return res.status(403).json({ error: 'Forbidden' });
  next();
}

/**
 * Authenticates x-api-key and sets req.tenantId. The lookup is narrowed by the
 * stored key prefix, so it costs one bcrypt comparison however many keys exist.
 * "No such prefix" and "wrong key" return the same response.
 */
export type KeyScope = 'ingest' | 'mcp';

/**
 * Authenticates a tenant API key and sets req.tenantId. A key only works for its own scope: an ingestion key
 * cannot read data through MCP and an MCP key cannot push logs. The key comes in x-api-key, or as a Bearer
 * token (what MCP clients send).
 */
export function apiKeyAuth(scope: KeyScope) {
  return async function (req: Request, res: Response, next: NextFunction) {
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7).trim() : '';
    const apiKey = req.headers['x-api-key']?.toString() || bearer;
    if (!apiKey) return res.status(401).json({ error: 'Missing API key' });

    try {
      const candidates = await query(
        `SELECT k.id, k.key_hash, k.tenant_id
           FROM wk_api_keys k
          WHERE k.key_prefix = $1 AND k.is_active AND k.scope = $2
            AND (k.expires_at IS NULL OR k.expires_at > NOW())`,
        [AuthService.apiKeyPrefix(apiKey), scope]
      );

      for (const c of candidates.rows) {
        if (await AuthService.verifyApiKey(apiKey, c.key_hash)) {
          await query(`UPDATE wk_api_keys SET last_used_at = NOW() WHERE id = $1`, [c.id]);
          req.tenantId = c.tenant_id;
          req.apiKeyId = c.id;
          return next();
        }
      }
      return res.status(401).json({ error: 'Invalid API key' });
    } catch (error: any) {
      logger.error(`[Auth] API key validation failed: ${error.message}`);
      return res.status(401).json({ error: 'API key validation failed' });
    }
  };
}

/** Ingestion keys (what Workato uses to push job logs). */
export const apiKeyAuthMiddleware = apiKeyAuth('ingest');
