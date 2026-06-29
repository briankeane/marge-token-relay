import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { sessionKey, type SessionRecord } from '../lib/session.js';
import { sha256Base64, constantTimeEqualBase64 } from '../lib/crypto.js';

export function resultRouter(deps: AppDeps): Router {
  const router = Router();
  router.post('/result', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = body.sessionId;
    const pickupSecret = body.pickup_secret;
    if (typeof sessionId !== 'string' || typeof pickupSecret !== 'string') {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const raw = await deps.kv.get(sessionKey(sessionId));
    if (!raw) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const record = JSON.parse(raw) as SessionRecord;

    // Constant-time compare of the pickup secret hash before anything else.
    if (!constantTimeEqualBase64(record.pickupHash, sha256Base64(pickupSecret))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    if (record.status !== 'complete') {
      res.status(204).end();
      return;
    }

    // Single-use: consume the session now.
    await deps.kv.getAndDelete(sessionKey(sessionId));
    if (record.error) {
      res.status(200).json({ error: record.error });
    } else {
      res.status(200).json({ sealedCode: record.sealedCode });
    }
  });
  return router;
}
