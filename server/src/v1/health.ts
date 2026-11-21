import { Router } from 'express';

export const v1HealthRouter = Router();
v1HealthRouter.get('/healthCheck', (_req, res) => {
  res.json({ status: 'ok' });
});
