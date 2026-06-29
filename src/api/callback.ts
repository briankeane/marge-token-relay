import { Router } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppDeps } from '../app.js';
import { sessionKey, stateKey, type SessionRecord } from '../lib/session.js';
import { seal } from '../lib/crypto.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function callbackRouter(deps: AppDeps): Router {
  const router = Router();
  router.get('/callback', async (req, res) => {
    const state = req.query.state;
    if (typeof state !== 'string' || state.length === 0) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    // Consume the state index atomically up front (single GETDEL). A retried
    // callback (e.g. browser back/resubmit) finds no state and gets 410, so it
    // can never overwrite a session whose code the bot may have already picked up.
    const sessionId = await deps.kv.getAndDelete(stateKey(state));
    if (!sessionId) {
      res.status(410).sendFile(path.join(publicDir, 'error.html'));
      return;
    }
    const raw = await deps.kv.get(sessionKey(sessionId));
    if (!raw) {
      res.status(410).sendFile(path.join(publicDir, 'error.html'));
      return;
    }
    const record = JSON.parse(raw) as SessionRecord;

    const error = typeof req.query.error === 'string' ? req.query.error : undefined;
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;

    record.status = 'complete';
    if (error) {
      record.error = error;
    } else if (code) {
      // NEVER log the code.
      record.sealedCode = seal(code, record.botPublicKey);
    } else {
      record.error = 'missing_code';
    }

    const ttl = deps.config.sessionTtlSeconds;
    await deps.kv.put(sessionKey(sessionId), JSON.stringify(record), ttl);

    const page = record.error ? 'error.html' : 'success.html';
    res.status(200).sendFile(path.join(publicDir, page));
  });
  return router;
}
