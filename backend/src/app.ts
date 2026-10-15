import express from 'express';
import 'express-async-errors';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env.js';

import healthRoutes from './routes/health.routes.js';
import authRoutes from './routes/auth.routes.js';
import adminRoutes from './routes/admin.routes.js';
import membersRoutes from './routes/members.routes.js';
import ingestRoutes from './routes/ingest.routes.js';
import tenantRoutes from './routes/tenant.routes.js';
import generatorRoutes from './routes/generator.routes.js';
import actionsRoutes from './routes/actions.routes.js';
import platformRoutes from './routes/platform.routes.js';
import alertsRoutes from './routes/alerts.routes.js';
import ackRulesRoutes from './routes/ackRules.routes.js';
import chatRoutes from './routes/chat.routes.js';
import mcpRoutes from './routes/mcp.routes.js';
import partnersRoutes from './routes/partners.routes.js';

/**
 * Builds the Express app. No side effects (no port, no workers) so tests can
 * import it; index.ts owns starting things.
 */
export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: [env.PORTAL_URL], credentials: true }));
  if (env.NODE_ENV !== 'test') app.use(morgan('combined'));

  // Ingest takes whole Workato job logs (~80KB for a small PO), so it gets its
  // own larger limit; everything else stays small.
  app.use('/api/mcp', express.json({ limit: '64kb' }), mcpRoutes);
  app.use('/api/v1/ingest', express.json({ limit: env.INGEST_BODY_LIMIT }), ingestRoutes);
  app.use(express.json({ limit: '1mb' }));

  app.use('/api/health', healthRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/admin/tenants/:tenantId/members', membersRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/platform', platformRoutes);
  app.use('/api/tenants/:tenantId/generator', generatorRoutes);
  app.use('/api/tenants/:tenantId/partners', partnersRoutes);
  app.use('/api/tenants/:tenantId/alerts', alertsRoutes);
  app.use('/api/tenants/:tenantId/ack-rules', ackRulesRoutes);
  app.use('/api/tenants/:tenantId/chat', chatRoutes);
  app.use('/api/tenants/:tenantId/actions', actionsRoutes);
  app.use('/api/tenants/:tenantId', tenantRoutes);

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Malformed JSON / oversized body are the caller's fault, not a 500
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
    console.error('Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
