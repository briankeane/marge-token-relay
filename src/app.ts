import express, { type Express } from 'express';
import type { KV } from './lib/kv.js';
import type { Config } from './config.js';
import { healthRouter } from './api/health.js';
import { errorHandler } from './middleware/error.js';

export interface AppDeps {
  kv: KV;
  config: Config;
}

export function buildApp(_deps: AppDeps): Express {
  const app = express();
  app.use(express.json());
  app.use(healthRouter);
  app.use(errorHandler);
  return app;
}
