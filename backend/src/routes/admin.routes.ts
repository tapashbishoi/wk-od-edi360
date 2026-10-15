import { env } from '../config/env.js';
import { publicApiUrl } from '../utils/publicUrl.js';
import { aiUsage30d, noAiUse, tenantChannelStats } from '../services/activity.service.js';
import { MODEL_NAME, PROVIDERS, isProvider } from '../services/chat/providers.js';
import { Router } from 'express';
import { query, queryOne, transaction } from '../db/connection.js';
import { authMiddleware, platformAdminOnly, requireTenantAccess, requireActiveTenant, clearTenantStatusCache } from '../middleware/auth.middleware.js';
import { AuthService } from '../services/auth.service.js';
import { audit } from '../services/audit.service.js';
import { encryptSecret, secretHint } from '../utils/crypto.js';
import { validateSlug, queueNameFor, dlqNameFor } from '../utils/tenantNaming.js';
import { inspectQueue } from '../services/queues.js';
import { runReadiness } from '../services/readiness.service.js';
import { canTransition, isTenantStatus, TenantStatus } from '../services/tenantLifecycle.js';
import { tenantConsumers } from '../services/tenantConsumer.js';
import { TicketError, loadTicketConfig, normalizeConfig, testConnection } from '../services/ticketing.service.js';
import { requeueFailed } from '../services/rawEdi.service.js';
import { syncTenantNow, tenantSyncStatus } from '../services/ticketSync.service.js';
import { ticketSyncWorker } from '../services/ticketSync.worker.js';

const router = Router();
router.use(authMiddleware, requireActiveTenant);

const TENANT_COLUMNS = `id, slug, name, status, plan, timezone, retention_days, source_mode,
  workato_account_id, raw_edi_enabled, queue_name, dlq_name, created_at, updated_at`;

// ---------------------------------------------------------------- tenants

router.get('/tenants', platformAdminOnly, async (_req, res) => {
  const { rows } = await query(`SELECT ${TENANT_COLUMNS} FROM wk_tenants ORDER BY name`);
  res.json({ tenants: rows });
});

router.post('/tenants', platformAdminOnly, async (req, res) => {
  const { name, slug, timezone, retention_days, source_mode, workato_account_id } = req.body ?? {};

  if (typeof name !== 'string' || name.trim() === '') return res.status(400).json({ error: 'Name is required' });
  const slugError = validateSlug(slug);
  if (slugError) return res.status(400).json({ error: slugError });
  if (source_mode !== undefined && !['push', 'poll'].includes(source_mode)) {
    return res.status(400).json({ error: 'source_mode must be "push" or "poll"' });
  }
  if (retention_days !== undefined && retention_days !== null && !(Number.isInteger(retention_days) && retention_days > 0)) {
    return res.status(400).json({ error: 'retention_days must be a positive integer' });
  }

  try {
    const tenant = await queryOne(
      `INSERT INTO wk_tenants (name, slug, timezone, retention_days, source_mode, workato_account_id, queue_name, dlq_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${TENANT_COLUMNS}`,
      [
        name.trim(),
        slug,
        timezone ?? 'UTC',
        retention_days ?? null,
        source_mode ?? 'push',
        workato_account_id != null ? String(workato_account_id) : null,
        queueNameFor(slug),
        dlqNameFor(slug),
      ]
    );
    await audit(req, { action: 'tenant.create', tenantId: tenant.id, target: slug });
    res.status(201).json({ tenant });
  } catch (error: any) {
    if (error.code === '23505') return res.status(409).json({ error: 'A tenant with that name or slug already exists' });
    throw error;
  }
});

router.get('/tenants/:tenantId', requireTenantAccess, async (req, res) => {
  const tenant = await queryOne(`SELECT ${TENANT_COLUMNS} FROM wk_tenants WHERE id = $1`, [req.params.tenantId]);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const [credentials, apiKeys, queue, stats] = await Promise.all([
    // Never the secret: kind, environment and the last four characters only
    query(`SELECT kind, environment, secret_hint, rotated_at, extra FROM wk_tenant_credentials WHERE tenant_id = $1`, [tenant.id]),
    query(
      `SELECT id, name, key_prefix, scope, is_active, last_used_at, created_at, expires_at FROM wk_api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenant.id]
    ),
    inspectQueue(tenant.queue_name),
    tenantChannelStats(tenant.id),
  ]);

  // Where Workato should send logs, and where an MCP client connects
  const pub = publicApiUrl(req);
  const endpoints = { ingestUrl: `${pub.url}/api/v1/ingest/workato`, mcpUrl: `${pub.url}/api/mcp`, mcpEnabled: env.MCP_ENABLED, urlFromEnv: pub.fromEnv };

  res.json({ tenant, credentials: credentials.rows, apiKeys: apiKeys.rows, queue, endpoints, activity: stats });
});

router.patch('/tenants/:tenantId', platformAdminOnly, async (req, res) => {
  const { name, timezone, retention_days, source_mode, workato_account_id, raw_edi_enabled } = req.body ?? {};
  if (raw_edi_enabled !== undefined && typeof raw_edi_enabled !== 'boolean') {
    return res.status(400).json({ error: 'raw_edi_enabled must be true or false' });
  }
  if (source_mode !== undefined && !['push', 'poll'].includes(source_mode)) {
    return res.status(400).json({ error: 'source_mode must be "push" or "poll"' });
  }
  if (retention_days != null && !(Number.isInteger(retention_days) && retention_days > 0)) {
    return res.status(400).json({ error: 'retention_days must be a positive integer' });
  }

  // Slug and queue names are deliberately not editable: renaming a queue
  // orphans whatever is on it.
  const tenant = await queryOne(
    `UPDATE wk_tenants SET
       name = COALESCE($2, name),
       timezone = COALESCE($3, timezone),
       retention_days = CASE WHEN $4::boolean THEN $5::int ELSE retention_days END,
       source_mode = COALESCE($6, source_mode),
       workato_account_id = CASE WHEN $7::boolean THEN $8 ELSE workato_account_id END,
       raw_edi_enabled = COALESCE($9, raw_edi_enabled)
     WHERE id = $1 RETURNING ${TENANT_COLUMNS}`,
    [
      req.params.tenantId,
      typeof name === 'string' ? name.trim() : null,
      timezone ?? null,
      'retention_days' in (req.body ?? {}),
      retention_days ?? null,
      source_mode ?? null,
      'workato_account_id' in (req.body ?? {}),
      workato_account_id != null ? String(workato_account_id) : null,
      raw_edi_enabled ?? null,
    ]
  );
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  await audit(req, { action: 'tenant.update', tenantId: tenant.id, target: tenant.slug, details: { fields: Object.keys(req.body ?? {}) } });
  res.json({ tenant });
});

// ---------------------------------------------------------------- lifecycle

router.post('/tenants/:tenantId/readiness', platformAdminOnly, async (req, res) => {
  const result = await runReadiness(Number(req.params.tenantId));
  await audit(req, { action: 'tenant.readiness', tenantId: Number(req.params.tenantId), outcome: result.ok ? 'success' : 'failure' });
  res.json(result);
});

router.post('/tenants/:tenantId/status', platformAdminOnly, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const to = req.body?.status;
  if (!isTenantStatus(to)) return res.status(400).json({ error: 'Unknown status' });

  const tenant = await queryOne<{ status: TenantStatus; slug: string }>(`SELECT status, slug FROM wk_tenants WHERE id = $1`, [tenantId]);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  if (!canTransition(tenant.status, to)) {
    return res.status(409).json({ error: `Cannot move a tenant from ${tenant.status} to ${to}` });
  }

  // Readiness proves something before the state changes, so it runs first. It gates opening ingestion
  // (the queue must exist) and the FIRST activation (everything must pass). Resuming a suspended tenant
  // is not a first activation: it was live before, and a pause must be reversible even if, say, a key
  // was revoked meanwhile.
  const firstActivation = to === 'active' && tenant.status === 'validation_pending';
  if (to === 'validation_pending' || firstActivation) {
    const readiness = await runReadiness(tenantId);
    const queue = readiness.checks.find((c) => c.name === 'queue_declared');
    // Opening ingestion only needs the queue; going live needs everything
    const blocked = to === 'active' ? !readiness.ok : queue?.status === 'fail';
    if (blocked) return res.status(412).json({ error: 'Readiness checks failed', ...readiness });
  }

  await transaction(async (client) => {
    await client.query(`UPDATE wk_tenants SET status = $2 WHERE id = $1`, [tenantId, to]);
    if (to === 'offboarded') {
      // Offboarding revokes credentials. The approved export/deletion workflow is a later slice.
      await client.query(`UPDATE wk_api_keys SET is_active = false WHERE tenant_id = $1`, [tenantId]);
      // Members lose access too; their records stay for the audit trail
      await client.query(`UPDATE wk_users SET is_active = false WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM wk_tenant_credentials WHERE tenant_id = $1`, [tenantId]);
    }
  });

  await audit(req, { action: 'tenant.status', tenantId, target: tenant.slug, details: { from: tenant.status, to } });
  clearTenantStatusCache(tenantId); // a suspension must lock members out now, not after the cache expires
  void tenantConsumers.sync(); // take effect now rather than at the next timer tick
  res.json({ status: to });
});

// ---------------------------------------------------------------- credentials

router.put('/tenants/:tenantId/credentials/:kind', requireTenantAccess, async (req, res) => {
  const { kind } = req.params;
  if (!['orderful', 'workato', 'gemini', 'brevo', 'openai', 'anthropic'].includes(kind)) return res.status(400).json({ error: 'Unknown credential kind' });

  const { secret, environment, extra } = req.body ?? {};

  // Orderful organisation id: only used to build the "Open in Orderful" link (viewAs=<id>). Not a secret,
  // and settable on its own so the key does not have to be typed in again.
  const viewAsRaw = kind === 'orderful' && extra?.viewAs !== undefined ? String(extra.viewAs).trim() : undefined;
  if (viewAsRaw !== undefined && viewAsRaw !== '' && !/^\d{1,12}$/.test(viewAsRaw)) return res.status(400).json({ error: 'The Orderful organisation id is a number, e.g. 26543' });
  if (secret === undefined && viewAsRaw !== undefined) {
    const tid = Number(req.params.tenantId);
    const upd = await query(
      `UPDATE wk_tenant_credentials SET extra = CASE WHEN $3 = '' THEN extra - 'viewAs' ELSE extra || jsonb_build_object('viewAs', $3::text) END
        WHERE tenant_id = $1 AND kind = $2`,
      [tid, kind, viewAsRaw]
    );
    if (!upd.rowCount) return res.status(404).json({ error: 'Save the Orderful API key first' });
    await audit(req, { action: 'credential.update', tenantId: tid, target: 'orderful/organisation' });
    return res.json({ kind, viewAs: viewAsRaw || null });
  }
  if (typeof secret !== 'string' || secret.length < 8) return res.status(400).json({ error: 'A secret is required' });

  // `extra` is sent back to the browser, so it is not a place for secrets: only a Brevo
  // sender address is accepted, validated, and everything else in it is dropped.
  const safeExtra: Record<string, string> = {};
  if (kind === 'brevo') {
    const sender = typeof extra?.senderEmail === 'string' ? extra.senderEmail.trim() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) {
      return res.status(400).json({ error: 'A valid sender email address is required for Brevo' });
    }
    safeExtra.senderEmail = sender;
  }

  const env = typeof environment === 'string' && environment ? environment : 'production';
  const tenantId = Number(req.params.tenantId);
  if (kind === 'orderful') {
    // Replacing the key keeps the organisation id unless a new one came with it
    const prior = await queryOne<{ extra: { viewAs?: string } }>(`SELECT extra FROM wk_tenant_credentials WHERE tenant_id = $1 AND kind = 'orderful' AND environment = $2`, [tenantId, env]);
    const viewAs = viewAsRaw !== undefined ? viewAsRaw : prior?.extra?.viewAs;
    if (viewAs) safeExtra.viewAs = viewAs;
  }
  if (!(await queryOne(`SELECT 1 FROM wk_tenants WHERE id = $1`, [tenantId]))) {
    return res.status(404).json({ error: 'Tenant not found' });
  }

  await query(
    `INSERT INTO wk_tenant_credentials (tenant_id, kind, environment, secret_enc, secret_hint, extra)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id, kind, environment)
     DO UPDATE SET secret_enc = EXCLUDED.secret_enc, secret_hint = EXCLUDED.secret_hint,
                   extra = EXCLUDED.extra, rotated_at = NOW()`,
    [tenantId, kind, env, encryptSecret(secret), secretHint(secret), JSON.stringify(safeExtra)]
  );

  // A replaced Orderful key may fix conversions that failed on the old one
  const requeued = kind === 'orderful' ? await requeueFailed(tenantId) : 0;

  // The secret is never in the audit details
  await audit(req, { action: 'credential.rotate', tenantId, target: `${kind}/${env}` });
  res.json({ kind, environment: env, secret_hint: secretHint(secret), requeued });
});

// ---------------------------------------------------------------- ticketing (Jira / ServiceNow)

/** The connection the tenant's admin saved, without the secret. */
router.get('/tenants/:tenantId/ticketing', requireTenantAccess, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const t = await queryOne<{ ticket_provider: string | null }>(`SELECT ticket_provider FROM wk_tenants WHERE id = $1`, [tenantId]);
  if (!t) return res.status(404).json({ error: 'Tenant not found' });
  const { rows } = await query(`SELECT kind, secret_hint, extra FROM wk_tenant_credentials WHERE tenant_id = $1 AND kind IN ('jira','servicenow')`, [tenantId]);
  res.json({ provider: t.ticket_provider, connections: Object.fromEntries(rows.map((r: any) => [r.kind, { ...r.extra, secretHint: r.secret_hint }])) });
});

router.put('/tenants/:tenantId/ticketing', requireTenantAccess, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!(await queryOne(`SELECT 1 FROM wk_tenants WHERE id = $1`, [tenantId]))) return res.status(404).json({ error: 'Tenant not found' });
  const { provider, secret, ...rest } = req.body ?? {};

  // Switching the ticket system off keeps the saved connections, so switching back needs no re-typing
  if (provider === null || provider === '') {
    await query(`UPDATE wk_tenants SET ticket_provider = NULL WHERE id = $1`, [tenantId]);
    await audit(req, { action: 'ticketing.disable', tenantId });
    return res.json({ provider: null });
  }

  try {
    const config = await normalizeConfig(provider, rest);
    const kind = config.provider;
    const { provider: _drop, ...extra } = config;
    const prior = await queryOne(`SELECT 1 FROM wk_tenant_credentials WHERE tenant_id = $1 AND kind = $2`, [tenantId, kind]);
    if (typeof secret === 'string' && secret.length > 0) {
      if (secret.length < 8) return res.status(400).json({ error: 'That token or password looks too short' });
      await query(
        `INSERT INTO wk_tenant_credentials (tenant_id, kind, environment, secret_enc, secret_hint, extra) VALUES ($1,$2,'production',$3,$4,$5)
         ON CONFLICT (tenant_id, kind, environment) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, secret_hint = EXCLUDED.secret_hint, extra = EXCLUDED.extra, rotated_at = NOW()`,
        [tenantId, kind, encryptSecret(secret), secretHint(secret), JSON.stringify(extra)]
      );
    } else if (prior) {
      // Settings changed, secret kept
      await query(`UPDATE wk_tenant_credentials SET extra = $3 WHERE tenant_id = $1 AND kind = $2`, [tenantId, kind, JSON.stringify(extra)]);
    } else {
      return res.status(400).json({ error: kind === 'jira' ? 'The Jira API token is required' : 'The ServiceNow password is required' });
    }
    await query(`UPDATE wk_tenants SET ticket_provider = $2 WHERE id = $1`, [tenantId, kind]);
    await audit(req, { action: 'ticketing.configure', tenantId, target: kind });
    res.json({ provider: kind });
  } catch (e) {
    if (e instanceof TicketError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

/** The portal assistant for this tenant: on or off, daily cap, and which AI model answers. */
router.get('/tenants/:tenantId/assistant', requireTenantAccess, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const t = await queryOne<{ chat_enabled: boolean; chat_daily_limit: number | null; chat_provider: string; chat_model: string | null }>(`SELECT chat_enabled, chat_daily_limit, chat_provider, chat_model FROM wk_tenants WHERE id = $1`, [tenantId]);
  if (!t) return res.status(404).json({ error: 'Tenant not found' });
  const [used, keys, ai] = await Promise.all([
    queryOne<{ messages: number }>(`SELECT messages FROM wk_chat_usage WHERE tenant_id = $1 AND day = CURRENT_DATE`, [tenantId]),
    query(`SELECT kind, secret_hint FROM wk_tenant_credentials WHERE tenant_id = $1 AND kind IN ('gemini','openai','anthropic')`, [tenantId]),
    aiUsage30d(tenantId),
  ]);
  res.json({
    enabled: t.chat_enabled, dailyLimit: t.chat_daily_limit, defaultLimit: env.CHAT_DAILY_LIMIT, usedToday: used?.messages ?? 0,
    provider: t.chat_provider, model: t.chat_model,
    usage30d: { chat: ai.find((x) => x.channel === 'chat')?.use ?? noAiUse(), explain: ai.find((x) => x.channel === 'explain')?.use ?? noAiUse() },
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, defaultModel: p.defaultModel, models: p.models, keyHint: (keys.rows.find((k: any) => k.kind === id) as any)?.secret_hint ?? null, hasKey: keys.rows.some((k: any) => k.kind === id) })),
  });
});

router.put('/tenants/:tenantId/assistant', requireTenantAccess, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const { enabled, dailyLimit, provider, model } = req.body ?? {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
  if (dailyLimit !== null && dailyLimit !== undefined && !(Number.isInteger(dailyLimit) && dailyLimit >= 10 && dailyLimit <= 10000)) return res.status(400).json({ error: 'The daily limit is a whole number from 10 to 10000, or empty for the default' });
  const chosen = provider === undefined ? 'gemini' : provider;
  if (!isProvider(chosen)) return res.status(400).json({ error: 'The model provider must be gemini, openai or anthropic' });
  const modelName = typeof model === 'string' && model.trim() ? model.trim() : null;
  if (modelName && !MODEL_NAME.test(modelName)) return res.status(400).json({ error: 'That model name has characters a model name does not use' });
  const r = await query(`UPDATE wk_tenants SET chat_enabled = $2, chat_daily_limit = $3, chat_provider = $4, chat_model = $5 WHERE id = $1`, [tenantId, enabled, dailyLimit ?? null, chosen, modelName]);
  if (!r.rowCount) return res.status(404).json({ error: 'Tenant not found' });
  await audit(req, { action: 'assistant.configure', tenantId, details: { enabled, dailyLimit: dailyLimit ?? null, provider: chosen, model: modelName } });
  res.json({ enabled, dailyLimit: dailyLimit ?? null, provider: chosen, model: modelName });
});

/** How ticket syncing is going for this tenant: counts, last and next read, and what went wrong. */
router.get('/tenants/:tenantId/ticketing/sync', requireTenantAccess, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const w = ticketSyncWorker.status();
  res.json({ ...(await tenantSyncStatus(tenantId)), worker: { running: w.started, lastRunAt: w.lastRunAt, lastError: w.lastError } });
});

const lastSyncNow = new Map<number, number>();

/** Reads the unfinished tickets now rather than on the schedule. */
router.post('/tenants/:tenantId/ticketing/sync', requireTenantAccess, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!(await loadTicketConfig(tenantId))) return res.status(409).json({ error: 'No ticket system is set up yet' });
  if (Date.now() - (lastSyncNow.get(tenantId) ?? 0) < 30_000) return res.status(429).json({ error: 'Just synced. Wait a few seconds.' });
  lastSyncNow.set(tenantId, Date.now());
  const result = await syncTenantNow(tenantId);
  await audit(req, { action: 'ticketing.sync', tenantId, details: result });
  res.json({ ...result, ...(await tenantSyncStatus(tenantId)) });
});

/** Proves the saved address and credentials work, without creating anything. */
router.post('/tenants/:tenantId/ticketing/test', requireTenantAccess, async (req, res) => {
  const cfg = await loadTicketConfig(Number(req.params.tenantId));
  if (!cfg) return res.status(409).json({ error: 'No ticket system is set up yet' });
  try {
    res.json(await testConnection(cfg));
  } catch (e) {
    if (e instanceof TicketError) return res.json({ ok: false, detail: e.message });
    throw e;
  }
});

// ---------------------------------------------------------------- API keys

router.post('/tenants/:tenantId/api-keys', requireTenantAccess, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!(await queryOne(`SELECT 1 FROM wk_tenants WHERE id = $1`, [tenantId]))) {
    return res.status(404).json({ error: 'Tenant not found' });
  }

  const scope = req.body?.scope === undefined ? 'ingest' : req.body.scope;
  if (scope !== 'ingest' && scope !== 'mcp') return res.status(400).json({ error: 'scope must be ingest or mcp' });

  const key = AuthService.generateApiKey();
  const row = await queryOne(
    `INSERT INTO wk_api_keys (tenant_id, key_hash, key_prefix, name, created_by, scope)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, key_prefix, name, scope, created_at`,
    [
      tenantId,
      await AuthService.hashApiKey(key),
      AuthService.apiKeyPrefix(key),
      typeof req.body?.name === 'string' ? req.body.name : null,
      req.user!.userId,
      scope,
    ]
  );

  await audit(req, { action: 'apikey.create', tenantId, target: row.id, details: { scope } });
  // The only time the key is ever visible
  res.status(201).json({ apiKey: key, ...row });
});

router.delete('/tenants/:tenantId/api-keys/:keyId', requireTenantAccess, async (req, res) => {
  const row = await queryOne(
    `UPDATE wk_api_keys SET is_active = false WHERE id = $1 AND tenant_id = $2 RETURNING id`,
    [req.params.keyId, req.params.tenantId]
  );
  if (!row) return res.status(404).json({ error: 'API key not found' });
  await audit(req, { action: 'apikey.revoke', tenantId: Number(req.params.tenantId), target: row.id });
  res.status(204).end();
});

// ---------------------------------------------------------------- quarantine

router.get('/tenants/:tenantId/quarantine', requireTenantAccess, async (req, res) => {
  const { rows } = await query(
    `SELECT id, reason, detail, retriable, source_mode, received_at, replayed_at
       FROM wk_ingest_quarantine WHERE tenant_id = $1 ORDER BY received_at DESC LIMIT 100`,
    [req.params.tenantId]
  );
  res.json({ quarantine: rows });
});

export default router;
