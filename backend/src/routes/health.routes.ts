import { Router } from 'express';
import { query } from '../db/connection.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'degraded', database: 'unreachable' });
  }
});

export default router;
