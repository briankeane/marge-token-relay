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
  // Required consent fields must be non-empty strings — a blank clientId/state
  // produces a Google authorization URL that Google rejects with no useful error.
  if (
    typeof clientId !== 'string' ||
    clientId.length === 0 ||
    typeof scopes !== 'string' ||
    scopes.length === 0 ||
    typeof state !== 'string' ||
    state.length === 0 ||
    typeof codeChallenge !== 'string' ||
    codeChallenge.length === 0 ||
    (loginHint !== undefined && typeof loginHint !== 'string')
  ) {
    return null;
  }
  return { clientId, scopes, state, codeChallenge, loginHint };
}

// A valid X25519 public key is exactly 32 bytes. Validate at session creation so
// the bot gets a clear 400 now, rather than the user hitting a 500 at /callback
// when seal() throws on a malformed key (after they've already consented).
function isValidX25519PublicKey(b64: string): boolean {
  return Buffer.from(b64, 'base64').length === 32;
}

export function sessionRouter(deps: AppDeps): Router {
  const router = Router();
  router.post('/session', async (req, res) => {
    const consent = parseConsent(req.body);
    const pickupHash = (req.body as Record<string, unknown>)?.pickupHash;
    const botPublicKey = (req.body as Record<string, unknown>)?.botPublicKey;
    if (
      !consent ||
      typeof pickupHash !== 'string' ||
      typeof botPublicKey !== 'string' ||
      !isValidX25519PublicKey(botPublicKey)
    ) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    // `state` must be unique per session (the bot generates it randomly). Reject a
    // reused state with 409 rather than silently overwriting the state→sessionId
    // mapping, which would seal a later callback's code into the wrong session.
    if (await deps.kv.get(stateKey(consent.state))) {
      res.status(409).json({ error: 'state_in_use' });
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
