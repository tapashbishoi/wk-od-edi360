import { Router } from 'express';
import { apiKeyAuthMiddleware } from '../middleware/auth.middleware.js';
import { extractJobs, ingestJobs, IngestError } from '../services/ingest.service.js';
import { recordActivity } from '../services/activity.service.js';

const router = Router();

/**
 * POST /api/v1/ingest/workato
 *
 * Accepts one Workato job log, an array of them, or {events: [...]}. 202 means
 * accepted onto the tenant's queue, not yet stored; quarantined events are
 * reported in the body so one bad event never hides the good ones.
 */
router.post('/workato', apiKeyAuthMiddleware, async (req, res) => {
  const t0 = Date.now();
  const log = (httpStatus: number, detail?: string) => recordActivity({ tenantId: req.tenantId!, channel: 'ingest', keyId: req.apiKeyId, action: 'ingest', ok: httpStatus < 400, httpStatus, ms: Date.now() - t0, detail });
  const jobs = extractJobs(req.body);
  if (jobs.length === 0) {
    log(400, 'No events in request body');
    return res.status(400).json({ error: 'No events in request body' });
  }

  try {
    const outcome = await ingestJobs(req.tenantId!, jobs, 'push');
    // Everything refused -> 422 so the sender notices; otherwise 202
    const status = outcome.accepted === 0 && outcome.quarantined.length > 0 ? 422 : 202;
    log(status, `accepted ${outcome.accepted}, quarantined ${outcome.quarantined.length}`);
    return res.status(status).json(outcome);
  } catch (error: any) {
    if (error instanceof IngestError) {
      log(error.status, error.message);
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Ingest error:', error);
    log(503, 'Ingestion unavailable');
    return res.status(503).json({ error: 'Ingestion temporarily unavailable, retry' });
  }
});

export default router;
