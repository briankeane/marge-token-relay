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

    // Single-use: atomically claim the session. Gate the response on getAndDelete's
    // return (not the earlier get) so two concurrent pollers can't both deliver the
    // sealed code — only the request whose GETDEL actually returned the value wins;
    // the loser sees null and gets 404.
    const claimed = await deps.kv.getAndDelete(sessionKey(sessionId));
    if (!claimed) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const claimedRecord = JSON.parse(claimed) as SessionRecord;
    if (claimedRecord.error) {
      res.status(200).json({ error: claimedRecord.error });
    } else {
      res.status(200).json({ sealedCode: claimedRecord.sealedCode });
    }
  });
  return router;
}
