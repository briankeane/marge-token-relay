import { Router } from 'express';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AppDeps } from '../app.js';
import { sessionKey, type SessionRecord } from '../lib/session.js';
import { DEFAULT_PROVIDER } from '../lib/providers.js';
import { isValidToken } from '../lib/ids.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
// Read the interstitial template and its auto-advance script ONCE at module load.
// The raw content is constant; only per-session values are substituted per request.
// Reading here (rather than per request) avoids file I/O on every link tap and turns
// a missing/mis-deployed asset into a startup crash instead of a runtime 500.
const connectHtmlTemplate = readFileSync(path.join(publicDir, 'connect.html'), 'utf8');
const connectAdvanceJs = readFileSync(path.join(publicDir, 'connect-advance.js'), 'utf8');

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
    // Show the provider's name on the page. The provider was validated against the
    // allowlist at /session, so it resolves here; fall back to the default (Google)
    // for any legacy record written before providers, and to the raw key defensively.
    const record = JSON.parse(raw) as SessionRecord;
    const providerKey = record.consent.provider ?? DEFAULT_PROVIDER;
    const providerName = deps.config.providers[providerKey]?.displayName ?? providerKey;

    // `session` has passed isValidToken (strict ^[A-Za-z0-9_-]{43}$), so it is safe
    // to interpolate into the href. providerName comes from our own config, not user
    // input. replaceAll (not replace) so every placeholder is substituted and none
    // can silently survive as a literal string.
    const html = connectHtmlTemplate
      .replaceAll('__AUTHORIZE_URL__', `/authorize?session=${session}`)
      .replaceAll('__PROVIDER_NAME__', providerName);
    res.status(200).type('html').send(html);
  });

  // Same-origin auto-advance script referenced by connect.html. Served as a static
  // asset (not inline) so helmet's CSP script-src 'self' allows it; crawlers fetch
  // but don't execute it, so the interstitial still protects the single-use token.
  router.get('/connect-advance.js', (_req, res) => {
    res.status(200).type('application/javascript').send(connectAdvanceJs);
  });
  return router;
}
