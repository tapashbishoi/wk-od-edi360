import { query } from '../db/connection.js';
import { logger } from '../utils/logger.js';

/**
 * A line in the activity log for the platform owner: which channel (ingest, MCP, assistant) was used,
 * how it went and how long it took. Never throws and never waits: a logging problem must not fail a
 * request. Nothing from the request body, no keys, no questions.
 */

export type Channel = 'ingest' | 'mcp' | 'chat' | 'explain';
const RETENTION_DAYS = 30;
let lastCleanup = 0;

export interface Activity {
  tenantId: number | null;
  channel: Channel;
  keyId?: string | null;
  action: string;
  ok: boolean;
  httpStatus?: number;
  ms?: number;
  detail?: string;
  /** AI calls: which model, what it used, and the cost at the price then (null when the price is unknown) */
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  costUsd?: number | null;
}

export function recordActivity(a: Activity): void {
  void query(
    `INSERT INTO wk_api_activity (tenant_id, channel, key_id, action, status, http_status, duration_ms, detail, provider, model, input_tokens, output_tokens, cached_tokens, cost_usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [a.tenantId, a.channel, a.keyId ?? null, a.action.slice(0, 60), a.ok ? 'ok' : 'error', a.httpStatus ?? null, a.ms === undefined ? null : Math.round(a.ms), a.detail?.slice(0, 300) ?? null,
     a.provider ?? null, a.model?.slice(0, 60) ?? null, a.inputTokens ?? null, a.outputTokens ?? null, a.cachedTokens ?? null, a.costUsd ?? null]
  ).catch((e: Error) => logger.warn(`[Activity] not recorded: ${e.message}`));

  // Trim old rows now and then, on the way past
  if (Date.now() - lastCleanup > 3_600_000) {
    lastCleanup = Date.now();
    void query(`DELETE FROM wk_api_activity WHERE created_at < NOW() - make_interval(days => ${RETENTION_DAYS})`).catch(() => undefined);
  }
}

export interface ChannelSummary {
  channel: Channel;
  calls24h: number;
  errors24h: number;
  avgMs: number | null;
  lastAt: string | null;
  lastErrorAt: string | null;
  /** AI channels only */
  tokens24h: number;
  cost24h: number;
}

export interface ChannelCount {
  calls24h: number;
  errors24h: number;
  lastAt: string | null;
}

export interface AiUse {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum of the costs that were known */
  costUsd: number;
  /** Requests whose model has no price on file, so are not in costUsd */
  unpriced: number;
}

export const noAiUse = (): AiUse => ({ requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpriced: 0 });

export interface TenantActivity {
  id: number;
  name: string;
  ingest: ChannelCount;
  mcp: ChannelCount;
  chat: ChannelCount;
  explain: ChannelCount;
  /** AI use over the last 30 days, for the platform owner's cost view */
  ai30d: { chat: AiUse; explain: AiUse };
  activeIngestKeys: number;
  activeMcpKeys: number;
}

const CHANNELS: Channel[] = ['ingest', 'mcp', 'chat', 'explain'];

/** Everything the platform owner's Integrations tab shows. */
/** AI requests, tokens and cost for the last 30 days, per tenant and channel. Only successful calls count. */
export async function aiUsage30d(tenantId?: number): Promise<{ tenant_id: number; channel: Channel; use: AiUse }[]> {
  const { rows } = await query(
    `SELECT tenant_id, channel, COUNT(*)::int AS requests, COALESCE(SUM(input_tokens), 0)::bigint AS inp, COALESCE(SUM(output_tokens), 0)::bigint AS outp,
            COALESCE(SUM(cost_usd), 0)::float AS cost, COUNT(*) FILTER (WHERE input_tokens IS NOT NULL AND cost_usd IS NULL)::int AS unpriced
       FROM wk_api_activity
      WHERE channel IN ('chat','explain') AND status = 'ok' AND tenant_id IS NOT NULL AND created_at > NOW() - INTERVAL '30 days' AND ($1::int IS NULL OR tenant_id = $1)
      GROUP BY tenant_id, channel`, [tenantId ?? null]);
  return rows.map((r: any) => ({ tenant_id: r.tenant_id, channel: r.channel, use: { requests: r.requests, inputTokens: Number(r.inp), outputTokens: Number(r.outp), costUsd: r.cost, unpriced: r.unpriced } }));
}

export async function activityOverview() {
  const ai = await aiUsage30d();
  const [channels, perTenant, tenants, errors] = await Promise.all([
    query(
      `SELECT channel, COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS "calls24h",
              COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours' AND status = 'error')::int AS "errors24h",
              (AVG(duration_ms) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours'))::int AS "avgMs",
              MAX(created_at) AS "lastAt", MAX(created_at) FILTER (WHERE status = 'error') AS "lastErrorAt",
              COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours'), 0)::bigint AS "tokens24h",
              COALESCE(SUM(cost_usd) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours'), 0)::float AS "cost24h"
         FROM wk_api_activity GROUP BY channel`
    ),
    query(
      `SELECT tenant_id, channel,
              COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS "calls24h",
              COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours' AND status = 'error')::int AS "errors24h",
              MAX(created_at) AS "lastAt"
         FROM wk_api_activity WHERE tenant_id IS NOT NULL GROUP BY tenant_id, channel`
    ),
    query(
      `SELECT t.id, t.name,
              (SELECT COUNT(*)::int FROM wk_api_keys k WHERE k.tenant_id = t.id AND k.is_active AND k.scope = 'ingest' AND (k.expires_at IS NULL OR k.expires_at > NOW())) AS "activeIngestKeys",
              (SELECT COUNT(*)::int FROM wk_api_keys k WHERE k.tenant_id = t.id AND k.is_active AND k.scope = 'mcp' AND (k.expires_at IS NULL OR k.expires_at > NOW())) AS "activeMcpKeys"
         FROM wk_tenants t ORDER BY t.name`
    ),
    query(
      `SELECT a.created_at AS at, t.name AS tenant, a.channel, a.action, a.http_status AS "httpStatus", a.detail
         FROM wk_api_activity a LEFT JOIN wk_tenants t ON t.id = a.tenant_id WHERE a.status = 'error' ORDER BY a.id DESC LIMIT 20`
    ),
  ]);

  const none: ChannelCount = { calls24h: 0, errors24h: 0, lastAt: null };
  const count = (tenantId: number, channel: Channel): ChannelCount => {
    const r = perTenant.rows.find((x: any) => x.tenant_id === tenantId && x.channel === channel);
    return r ? { calls24h: r.calls24h, errors24h: r.errors24h, lastAt: r.lastAt } : none;
  };

  return {
    channels: CHANNELS.map((c): ChannelSummary => ({ channel: c, calls24h: 0, errors24h: 0, avgMs: null, lastAt: null, lastErrorAt: null, tokens24h: 0, cost24h: 0, ...(channels.rows.find((r: any) => r.channel === c) ?? {}) })),
    tenants: tenants.rows.map((t: any): TenantActivity => ({
      id: t.id, name: t.name, activeIngestKeys: t.activeIngestKeys, activeMcpKeys: t.activeMcpKeys,
      ingest: count(t.id, 'ingest'), mcp: count(t.id, 'mcp'), chat: count(t.id, 'chat'), explain: count(t.id, 'explain'),
      ai30d: { chat: ai.find((x) => x.tenant_id === t.id && x.channel === 'chat')?.use ?? noAiUse(), explain: ai.find((x) => x.tenant_id === t.id && x.channel === 'explain')?.use ?? noAiUse() },
    })),
    recentErrors: errors.rows,
  };
}

export interface TenantChannelStats extends ChannelCount {
  lastError: { at: string; detail: string | null; httpStatus: number | null } | null;
}

/** One tenant's last day on each channel, with the most recent failure, for its settings page. */
export async function tenantChannelStats(tenantId: number): Promise<Record<Channel, TenantChannelStats>> {
  const [counts, errors] = await Promise.all([
    query(
      `SELECT channel, COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS "calls24h",
              COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours' AND status = 'error')::int AS "errors24h", MAX(created_at) AS "lastAt"
         FROM wk_api_activity WHERE tenant_id = $1 GROUP BY channel`, [tenantId]),
    query(
      `SELECT DISTINCT ON (channel) channel, created_at AS at, detail, http_status AS "httpStatus"
         FROM wk_api_activity WHERE tenant_id = $1 AND status = 'error' AND created_at > NOW() - INTERVAL '24 hours' ORDER BY channel, id DESC`, [tenantId]),
  ]);
  const one = (c: Channel): TenantChannelStats => {
    const r = counts.rows.find((x: any) => x.channel === c);
    const e = errors.rows.find((x: any) => x.channel === c);
    return { calls24h: r?.calls24h ?? 0, errors24h: r?.errors24h ?? 0, lastAt: r?.lastAt ?? null, lastError: e ? { at: e.at, detail: e.detail, httpStatus: e.httpStatus } : null };
  };
  return { ingest: one('ingest'), mcp: one('mcp'), chat: one('chat'), explain: one('explain') };
}
