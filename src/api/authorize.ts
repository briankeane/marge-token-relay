import { Router } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppDeps } from '../app.js';
import { sessionKey, type SessionRecord } from '../lib/session.js';
import { buildConsentUrl } from '../lib/google.js';
import { isValidToken } from '../lib/ids.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function authorizeRouter(deps: AppDeps): Router {
  const router = Router();
  router.get('/authorize', async (req, res) => {
    const session = req.query.session;
    if (!isValidToken(session)) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const raw = await deps.kv.get(sessionKey(session));
    if (!raw) {
      res.status(410).sendFile(path.join(publicDir, 'expired.html'));
      return;
    }
    const record = JSON.parse(raw) as SessionRecord;
    const url = buildConsentUrl({
      endpoint: deps.config.googleAuthEndpoint,
      redirectUri: `${deps.config.baseUrl}/callback`,
      consent: record.consent,
    });
    res.redirect(302, url);
  });
  return router;
}
