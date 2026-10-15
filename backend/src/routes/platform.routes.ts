import { Router } from 'express';
import { authMiddleware, platformAdminOnly } from '../middleware/auth.middleware.js';
import { buildOpenApi } from '../docs/openapi.js';
import { collectHealth } from '../services/health.service.js';
import { activityOverview } from '../services/activity.service.js';
import { env } from '../config/env.js';
import { publicApiUrl } from '../utils/publicUrl.js';

/**
 * /api/platform - for the platform owner only: the API description behind the Swagger page, and the
 * detailed health of every moving part. Never exposed to tenants.
 */
const router = Router();
router.use(authMiddleware, platformAdminOnly);

const spec = buildOpenApi();
router.get('/openapi.json', (_req, res) => {
  res.json(spec);
});

router.get('/health', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await collectHealth());
});

/** How the three ways in are doing: the ingestion API, the MCP server and the assistant. */
router.get('/activity', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const pub = publicApiUrl(req);
  res.json({
    endpoints: { ingestUrl: `${pub.url}/api/v1/ingest/workato`, mcpUrl: `${pub.url}/api/mcp`, mcpEnabled: env.MCP_ENABLED, urlFromEnv: pub.fromEnv },
    ...(await activityOverview()),
  });
});

export default router;
