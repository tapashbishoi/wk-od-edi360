import { Router } from 'express';
import { env } from '../config/env.js';
import { queryOne } from '../db/connection.js';
import { apiKeyAuth } from '../middleware/auth.middleware.js';
import { recordActivity } from '../services/activity.service.js';
import { ERR, handleRpc, type RpcRequest, type RpcResponse } from '../services/mcp.service.js';

/**
 * POST /api/mcp - EDI360's MCP server (read-only tools, one tenant per key). Authenticated by an MCP key
 * (Authorization: Bearer ... or x-api-key); an ingestion key does not work here. Stateless: every request
 * stands alone, replies are plain JSON.
 */
const router = Router();

const MAX_BATCH = 10;
const hits = new Map<string, number[]>();
const allow = (key: string, max = 120, now = Date.now()) => {
  const list = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= max) { hits.set(key, list); return false; }
  list.push(now);
  hits.set(key, list);
  return true;
};

router.use((req, res, next) => {
  if (!env.MCP_ENABLED) return res.status(503).json({ error: 'The MCP server is switched off on this platform.' });
  // A browser page has no business talking to this; non-browser MCP clients send no Origin
  const origin = req.headers.origin;
  if (origin && origin !== env.PORTAL_URL) return res.status(403).json({ error: 'Origin not allowed' });
  // Stateless and no server-sent streams: only POST is meaningful
  if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').json({ error: 'Use POST with a JSON-RPC 2.0 body.' });
  next();
});

router.post('/', apiKeyAuth('mcp'), async (req, res) => {
  const tenantId = req.tenantId!;
  if (!allow(req.apiKeyId ?? String(tenantId))) return res.status(429).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Too many requests. Slow down.' } });

  const body = req.body as RpcRequest | RpcRequest[];
  if (body === undefined || body === null || (typeof body !== 'object')) {
    return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: ERR.parse, message: 'Send a JSON-RPC 2.0 request body.' } });
  }
  const batch = Array.isArray(body);
  const messages = batch ? body : [body];
  if (messages.length === 0 || messages.length > MAX_BATCH) {
    return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: ERR.invalidRequest, message: `Send 1 to ${MAX_BATCH} requests.` } });
  }

  // Looked up once, only if a tool actually runs
  let tz: Promise<string> | null = null;
  const ctx = async () => {
    tz ??= queryOne<{ timezone: string }>(`SELECT timezone FROM wk_tenants WHERE id = $1`, [tenantId]).then((t) => t?.timezone ?? 'UTC');
    // An MCP key reads like a support user: documents, tickets and rules, no actions
    return { tenantId, userId: 'mcp', role: 'support', email: '', name: 'MCP client', timezone: await tz };
  };
  const log = (c: { action: string; ok: boolean; ms: number; detail?: string }) =>
    recordActivity({ tenantId, channel: 'mcp', keyId: req.apiKeyId, action: c.action, ok: c.ok, ms: c.ms, httpStatus: 200, detail: c.detail });

  const replies = (await Promise.all(messages.map((m) => handleRpc(m, ctx, log)))).filter((r): r is RpcResponse => r !== null);
  if (replies.length === 0) return res.status(202).end(); // only notifications
  res.json(batch ? replies : replies[0]);
});

export default router;
