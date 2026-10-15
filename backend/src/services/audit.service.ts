import type { Request } from 'express';
import { query } from '../db/connection.js';
import { logger } from '../utils/logger.js';

/**
 * Records a security-relevant action. Never throws: an audit write failing must
 * not turn a successful admin action into an error, but it is logged loudly.
 * Never pass secrets in `details`.
 */
export async function audit(
  req: Request | null,
  entry: { action: string; tenantId?: number | null; target?: string; outcome?: 'success' | 'failure'; details?: Record<string, unknown> }
): Promise<void> {
  try {
    await query(
      `INSERT INTO wk_audit_logs (tenant_id, actor_id, actor_role, action, target, outcome, ip, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.tenantId ?? req?.user?.tenantId ?? null,
        req?.user?.userId && req.user.userId !== 'api-key' ? req.user.userId : null,
        req?.user?.role ?? null,
        entry.action,
        entry.target ?? null,
        entry.outcome ?? 'success',
        req?.ip ?? null,
        JSON.stringify(entry.details ?? {}),
      ]
    );
  } catch (error: any) {
    logger.error(`[Audit] Failed to record ${entry.action}: ${error.message}`);
  }
}
