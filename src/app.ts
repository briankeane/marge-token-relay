import express, { type Express } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import type { KV } from './lib/kv.js';
import type { Config } from './config.js';
import { healthRouter } from './api/health.js';
import { sessionRouter } from './api/session.js';
import { authorizeRouter } from './api/authorize.js';
import { callbackRouter } from './api/callback.js';
import { resultRouter } from './api/result.js';
import { errorHandler } from './middleware/error.js';

export interface AppDeps {
  kv: KV;
  config: Config;
  rateLimit?: { windowMs: number; max: number };
}

export function buildApp(deps: AppDeps): Express {
  const app = express();
  app.use(helmet());
  app.use(express.json());

  const { windowMs, max } = deps.rateLimit ?? { windowMs: 60_000, max: 30 };
  const limiter = rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false });

  app.use(healthRouter);
  app.use('/session', limiter);
  app.use('/result', limiter);
  app.use(sessionRouter(deps));
  app.use(authorizeRouter(deps));
  app.use(callbackRouter(deps));
  app.use(resultRouter(deps));
  app.use(errorHandler);
  return app;
}
