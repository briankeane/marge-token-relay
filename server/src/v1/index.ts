import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { v1HealthRouter } from './health.js';

export function v1Router(_deps: AppDeps): Router {
  const router = Router();
  router.use(v1HealthRouter);
  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: (req as AuthedRequest).auth });
  });
  return router;
}
