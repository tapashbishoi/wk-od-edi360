import { Router, type Request } from 'express';
import { env } from '../config/env.js';
import { query, queryOne } from '../db/connection.js';
import { authMiddleware, requireActiveTenant, requireTenantMember } from '../middleware/auth.middleware.js';
import { audit } from '../services/audit.service.js';
import { KEY_PHRASE, PROVIDERS, chatSettings, providerKey } from '../services/chat/providers.js';
import { costOf } from '../services/chat/pricing.js';
import { cleanHistory, runAgent } from '../services/chat/agent.js';
import { ChatModelError } from '../services/chat/gemini.js';
import { logger } from '../utils/logger.js';
import { recordActivity } from '../services/activity.service.js';

/**
 * /api/tenants/:tenantId/chat - the portal assistant. Open to every member: what it can read is what the
 * portal already shows them, each tool re-checks the caller's role, and anything that changes something
 * comes back as a card the person confirms through the normal API. Uses the tenant's own Gemini key, can
 * be switched off per tenant, and is capped per tenant per day and per user per hour.
 */
const router = Router({ mergeParams: true });
router.use(authMiddleware, requireActiveTenant, requireTenantMember);

const tenantIdOf = (req: Request) => Number(req.params.tenantId);


interface Settings { enabled: boolean; limit: number; timezone: string }

async function settingsOf(tenantId: number): Promise<Settings> {
  const t = await queryOne<{ chat_enabled: boolean; chat_daily_limit: number | null; timezone: string }>(`SELECT chat_enabled, chat_daily_limit, timezone FROM wk_tenants WHERE id = $1`, [tenantId]);
  return { enabled: t?.chat_enabled ?? true, limit: t?.chat_daily_limit ?? env.CHAT_DAILY_LIMIT, timezone: t?.timezone ?? 'UTC' };
}

/** What the chat panel needs to know before it lets anyone type. */
router.get('/status', async (req, res) => {
  const tenantId = tenantIdOf(req);
  const [s, chosen, used] = await Promise.all([
    settingsOf(tenantId),
    chatSettings(tenantId),
    queryOne<{ messages: number }>(`SELECT messages FROM wk_chat_usage WHERE tenant_id = $1 AND day = CURRENT_DATE`, [tenantId]),
  ]);
  const key = await providerKey(tenantId, chosen.provider);
  res.json({ enabled: s.enabled, configured: !!key, provider: PROVIDERS[chosen.provider].label, model: chosen.model, dailyLimit: s.limit, usedToday: used?.messages ?? 0 });
});

const hits = new Map<string, number[]>();
const allowUser = (key: string, max = 60, now = Date.now()) => {
  const list = (hits.get(key) ?? []).filter((t) => now - t < 3_600_000);
  if (list.length >= max) { hits.set(key, list); return false; }
  list.push(now);
  hits.set(key, list);
  return true;
};

router.post('/', async (req, res) => {
  const tenantId = tenantIdOf(req);
  const history = cleanHistory(req.body?.messages);
  if (!history) return res.status(400).json({ error: 'Send the conversation so far, ending with your question.' });

  const s = await settingsOf(tenantId);
  if (!s.enabled) return res.status(403).json({ error: 'The assistant is switched off for this organisation.' });
  const chosen = await chatSettings(tenantId);
  if (!(await providerKey(tenantId, chosen.provider))) return res.status(409).json({ error: `The assistant is not set up yet: an administrator needs to save ${KEY_PHRASE[chosen.provider]} on the tenant page.` });
  if (!allowUser(`${tenantId}:${req.user!.userId}`)) return res.status(429).json({ error: 'That is a lot of questions in an hour. Try again a little later.' });

  const claimed = await queryOne(
    `INSERT INTO wk_chat_usage (tenant_id, day, messages) VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (tenant_id, day) DO UPDATE SET messages = wk_chat_usage.messages + 1 WHERE wk_chat_usage.messages < $2 RETURNING messages`,
    [tenantId, s.limit]
  );
  if (!claimed) return res.status(429).json({ error: `Your organisation has used its ${s.limit} assistant messages for today. It resets at midnight UTC, or an administrator can raise the limit.` });

  const me = await queryOne<{ email: string; first_name: string | null; last_name: string | null }>(`SELECT email, first_name, last_name FROM wk_users WHERE id = $1`, [req.user!.userId]);
  const name = [me?.first_name, me?.last_name].filter(Boolean).join(' ') || me?.email || 'the user';

  const t0 = Date.now();
  try {
    const r = await runAgent({ tenantId, userId: req.user!.userId, role: req.user!.role, email: me?.email ?? '', name, timezone: s.timezone }, history);
    await audit(req, { action: 'chat.message', tenantId, details: { tools: r.toolsUsed, proposals: r.proposals.map((p) => p.kind) } });
    recordActivity({ tenantId, channel: 'chat', action: r.toolsUsed.join(',') || 'answer', ok: true, httpStatus: 200, ms: Date.now() - t0, provider: chosen.provider, model: chosen.model, inputTokens: r.usage.input, outputTokens: r.usage.output, cachedTokens: r.usage.cached, costUsd: r.usage.calls && r.usage.input ? costOf(chosen.model, r.usage) : null });
    res.json({ reply: r.reply, proposals: r.proposals });
  } catch (e) {
    if (e instanceof ChatModelError) {
      await audit(req, { action: 'chat.message', tenantId, outcome: 'failure' });
      recordActivity({ tenantId, channel: 'chat', action: 'answer', ok: false, httpStatus: e.status, ms: Date.now() - t0, detail: e.detail ?? e.message });
      return res.status(e.status).json({ error: e.message });
    }
    logger.error(`[Chat] ${(e as Error)?.message}`);
    recordActivity({ tenantId, channel: 'chat', action: 'answer', ok: false, httpStatus: 500, ms: Date.now() - t0, detail: 'internal error' });
    res.status(500).json({ error: 'The assistant ran into a problem. Try again.' });
  }
});

export default router;
