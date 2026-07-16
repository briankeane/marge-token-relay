import { Router } from 'express';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AppDeps } from '../app.js';
import { sessionKey } from '../lib/session.js';
import { isValidToken } from '../lib/ids.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const connectHtmlPath = path.join(publicDir, 'connect.html');

/**
 * GET /connect?session=X — the static interstitial "bounce" page.
 *
 * The relay hands the bot a sign-in link that gets texted to a user over
 * iMessage. iMessage renders a link preview by having a crawler fetch the URL,
 * and crawlers FOLLOW redirects. If that link pointed straight at /authorize
 * (which 302-redirects into Google's one-shot OAuth consent flow on GET), the
 * preview crawler would burn the single-use sign-in before the human ever tapped
 * it. So the shared link points here instead: this handler serves static HTML
 * with a plain human-tappable anchor to /authorize. Crawlers parse but do NOT
 * navigate anchors, so the token survives; only a real human tap proceeds.
 *
 * Critically this must NOT auto-redirect — a redirecting bounce page fails
 * identically. And it must NOT mutate/consume any KV state on GET.
 */
export function connectRouter(deps: AppDeps): Router {
  const router = Router();
  router.get('/connect', async (req, res) => {
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
    // `session` has passed isValidToken (strict ^[A-Za-z0-9_-]{43}$), so it is
    // safe to interpolate into the href. No other user input is interpolated.
    const html = (await readFile(connectHtmlPath, 'utf8')).replace(
      '__AUTHORIZE_URL__',
      `/authorize?session=${session}`,
    );
    res.status(200).type('html').send(html);
  });
  return router;
}
