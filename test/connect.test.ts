import { expect } from 'chai';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MemoryKV } from '../src/lib/kv.js';
import { sessionKey, type SessionRecord } from '../src/lib/session.js';
import { newToken } from '../src/lib/ids.js';

function makeApp() {
  const config = loadConfig({
    BASE_URL: 'https://relay.test',
    KV_BACKEND: 'memory',
  } as NodeJS.ProcessEnv);
  const kv = new MemoryKV();
  return { app: buildApp({ kv, config }), kv, config };
}

const record: SessionRecord = {
  consent: { clientId: 'c1', scopes: 'openid', state: 'st1', codeChallenge: 'ch1' },
  pickupHash: 'h',
  botPublicKey: 'pk',
  status: 'pending',
  createdAt: Date.now(),
};

describe('GET /connect', () => {
  it('serves the static interstitial (200, no redirect) with the /authorize href and leaves the session unconsumed', async () => {
    const { app, kv } = makeApp();
    const id = newToken();
    await kv.put(sessionKey(id), JSON.stringify(record), 600);

    const res = await request(app).get(`/connect?session=${id}`).redirects(0);

    // Must be a static 200, NOT a 3xx redirect — a redirecting bounce page would
    // be followed by the iMessage preview crawler and burn the token.
    expect(res.status).to.equal(200);
    expect(res.status).to.not.be.within(300, 399);
    expect(res.headers.location).to.equal(undefined);

    // Body links to /authorize with this session so a human tap proceeds.
    expect(res.text).to.contain(`/authorize?session=${id}`);

    // GET /connect must not mutate/consume KV — the session survives for the tap.
    const stillThere = await kv.get(sessionKey(id));
    expect(stillThere).to.be.a('string');
    const parsed = JSON.parse(stillThere as string) as SessionRecord;
    expect(parsed.status).to.equal('pending');
  });

  it('still serves the interstitial for a completed session (documents intentional behavior)', async () => {
    // A session whose consent already completed remains in KV until TTL. Re-tapping
    // the old link renders the page and, on tap, /authorize redirects to Google —
    // but that reuses a `state` the callback already GETDEL'd, so a second callback
    // gets 410 and no code is ever re-sealed. We deliberately do NOT status-gate
    // /connect: it mirrors /authorize (which also serves completed sessions), and
    // the reuse is already rejected safely downstream. This test locks that in.
    const { app, kv } = makeApp();
    const id = newToken();
    const completed: SessionRecord = { ...record, status: 'complete', sealedCode: 'sealed' };
    await kv.put(sessionKey(id), JSON.stringify(completed), 600);

    const res = await request(app).get(`/connect?session=${id}`).redirects(0);

    expect(res.status).to.equal(200);
    expect(res.text).to.contain(`/authorize?session=${id}`);
  });

  it('renders provider-specific copy for a Spotify session (not "Google")', async () => {
    const { app, kv } = makeApp();
    const id = newToken();
    const spotify: SessionRecord = {
      ...record,
      consent: { ...record.consent, provider: 'spotify' },
    };
    await kv.put(sessionKey(id), JSON.stringify(spotify), 600);

    const res = await request(app).get(`/connect?session=${id}`).redirects(0);
    expect(res.status).to.equal(200);
    expect(res.text).to.contain('Spotify');
    expect(res.text).to.not.contain('Google');
  });

  it('renders Google copy for a session with no provider (legacy default)', async () => {
    const { app, kv } = makeApp();
    const id = newToken();
    await kv.put(sessionKey(id), JSON.stringify(record), 600); // record has no provider
    const res = await request(app).get(`/connect?session=${id}`).redirects(0);
    expect(res.text).to.contain('Google');
    expect(res.text).to.not.contain('Spotify');
  });

  it('includes the browser-only auto-advance (external script + anchor id) and keeps the no-JS fallback link', async () => {
    const { app, kv } = makeApp();
    const id = newToken();
    await kv.put(sessionKey(id), JSON.stringify(record), 600);
    const res = await request(app).get(`/connect?session=${id}`).redirects(0);

    // A real browser runs this same-origin script and navigates; crawlers don't.
    expect(res.text).to.contain('<script src="/connect-advance.js">');
    expect(res.text).to.contain('id="continue"');
    // The plain anchor must survive as the crawler-safe / no-JS fallback.
    expect(res.text).to.contain(`href="/authorize?session=${id}"`);
    // Still a static 200, never a redirect.
    expect(res.status).to.equal(200);
    expect(res.headers.location).to.equal(undefined);
  });

  it('returns 410 for a well-formed but unknown/expired session', async () => {
    const { app } = makeApp();
    const res = await request(app).get(`/connect?session=${newToken()}`).redirects(0);
    expect(res.status).to.equal(410);
  });

  it('returns 400 for a malformed/missing session param', async () => {
    const { app } = makeApp();
    expect((await request(app).get('/connect').redirects(0)).status).to.equal(400);
    expect((await request(app).get('/connect?session=not-a-token').redirects(0)).status).to.equal(
      400,
    );
  });
});

describe('GET /connect-advance.js', () => {
  it('serves the same-origin auto-advance script as JavaScript', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/connect-advance.js');
    expect(res.status).to.equal(200);
    expect(res.headers['content-type']).to.match(/javascript/);
    // Navigates via the interstitial anchor using location.replace; crawlers don't run it.
    expect(res.text).to.contain('continue');
    expect(res.text).to.contain('location');
    expect(res.text).to.contain('replace');
  });
});
