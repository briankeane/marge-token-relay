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

describe('GET /authorize', () => {
  it('302-redirects to Google with redirect_uri set to this app callback', async () => {
    const { app, kv } = makeApp();
    const id = newToken();
    await kv.put(sessionKey(id), JSON.stringify(record), 600);
    const res = await request(app).get(`/authorize?session=${id}`).redirects(0);
    expect(res.status).to.equal(302);
    const loc = new URL(res.headers.location);
    expect(loc.origin).to.equal('https://accounts.google.com');
    expect(loc.searchParams.get('redirect_uri')).to.equal('https://relay.test/callback');
    expect(loc.searchParams.get('client_id')).to.equal('c1');
    expect(loc.searchParams.get('state')).to.equal('st1');
  });

  it('returns 410 for a well-formed but unknown/expired session', async () => {
    const { app } = makeApp();
    const res = await request(app).get(`/authorize?session=${newToken()}`).redirects(0);
    expect(res.status).to.equal(410);
  });

  it('returns 400 for a malformed/missing session param', async () => {
    const { app } = makeApp();
    expect((await request(app).get('/authorize').redirects(0)).status).to.equal(400);
    expect((await request(app).get('/authorize?session=not-a-token').redirects(0)).status).to.equal(
      400,
    );
  });
});
