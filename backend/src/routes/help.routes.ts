import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Router } from 'express';
import { authMiddleware, requireActiveTenant } from '../middleware/auth.middleware.js';

/**
 * /api/help - the user guide, for any signed-in user. It is served through the API (not as a public file)
 * so the Help page can only be read after signing in. The PDF is built from backend/assets/guide/.
 */
const router = Router();
router.use(authMiddleware, requireActiveTenant);

const GUIDE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/guide/EDI360-User-Guide.pdf');

router.get('/user-guide.pdf', (_req, res) => {
  if (!fs.existsSync(GUIDE)) return res.status(404).json({ error: 'The user guide is not available' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="EDI360-User-Guide.pdf"');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  fs.createReadStream(GUIDE).pipe(res);
});

export default router;
