import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { newToken } from '../lib/ids.js';
import { sessionKey, stateKey, type SessionRecord } from '../lib/session.js';
import type { ConsentParams } from '../lib/google.js';

function parseConsent(body: unknown): ConsentParams | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const c = b.consent as Record<string, unknown> | undefined;
  if (!c) return null;
  const { clientId, scopes, state, codeChallenge, loginHint } = c;
  if (
    typeof clientId !== 'string' ||
    typeof scopes !== 'string' ||
    typeof state !== 'string' ||
    typeof codeChallenge !== 'string' ||
    (loginHint !== undefined && typeof loginHint !== 'string')
  ) {
    return null;
  }
  return { clientId, scopes, state, codeChallenge, loginHint };
}

export function sessionRouter(deps: AppDeps): Router {
  const router = Router();
  router.post('/session', async (req, res) => {
    const consent = parseConsent(req.body);
    const pickupHash = (req.body as Record<string, unknown>)?.pickupHash;
    const botPublicKey = (req.body as Record<string, unknown>)?.botPublicKey;
    if (!consent || typeof pickupHash !== 'string' || typeof botPublicKey !== 'string') {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const sessionId = newToken();
    const record: SessionRecord = {
      consent,
      pickupHash,
      botPublicKey,
      status: 'pending',
      createdAt: Date.now(),
    };
    const ttl = deps.config.sessionTtlSeconds;
    await deps.kv.put(sessionKey(sessionId), JSON.stringify(record), ttl);
    await deps.kv.put(stateKey(consent.state), sessionId, ttl);

    res.status(201).json({
      sessionId,
      authorizeUrl: `${deps.config.baseUrl}/authorize?session=${sessionId}`,
    });
  });
  return router;
}
