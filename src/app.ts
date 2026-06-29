import express, { type Express } from 'express';
import type { KV } from './lib/kv.js';
import type { Config } from './config.js';
import { healthRouter } from './api/health.js';
import { sessionRouter } from './api/session.js';
import { authorizeRouter } from './api/authorize.js';
import { callbackRouter } from './api/callback.js';
import { errorHandler } from './middleware/error.js';

export interface AppDeps {
  kv: KV;
  config: Config;
}

export function buildApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json());
  app.use(healthRouter);
  app.use(sessionRouter(deps));
  app.use(authorizeRouter(deps));
  app.use(callbackRouter(deps));
  app.use(errorHandler);
  return app;
}
