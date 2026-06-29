import { expect } from 'chai';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MemoryKV } from '../src/lib/kv.js';
import { sessionKey, type SessionRecord } from '../src/lib/session.js';
import { sha256Base64, initCrypto } from '../src/lib/crypto.js';

const PICKUP = 'super-secret-pickup';

function makeApp() {
  const config = loadConfig({
    BASE_URL: 'https://relay.test',
    KV_BACKEND: 'memory',
  } as NodeJS.ProcessEnv);
  const kv = new MemoryKV();
  return { app: buildApp({ kv, config }), kv };
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    consent: { clientId: 'c1', scopes: 'openid', state: 'st1', codeChallenge: 'ch1' },
    pickupHash: sha256Base64(PICKUP),
    botPublicKey: 'pk',
    status: 'complete',
    sealedCode: 'sealed-code-b64',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('POST /result', () => {
  before(async () => {
    await initCrypto();
  });

  it('returns the sealed code once, then 404 (single-use)', async () => {
    const { app, kv } = makeApp();
    await kv.put(sessionKey('s1'), JSON.stringify(record()), 600);

    const first = await request(app)
      .post('/result')
      .send({ sessionId: 's1', pickup_secret: PICKUP });
    expect(first.status).to.equal(200);
    expect(first.body.sealedCode).to.equal('sealed-code-b64');

    const second = await request(app)
      .post('/result')
      .send({ sessionId: 's1', pickup_secret: PICKUP });
    expect(second.status).to.equal(404);
  });

  it('returns 204 while still pending', async () => {
    const { app, kv } = makeApp();
    await kv.put(
      sessionKey('s2'),
      JSON.stringify(record({ status: 'pending', sealedCode: undefined })),
      600,
    );
    const res = await request(app).post('/result').send({ sessionId: 's2', pickup_secret: PICKUP });
    expect(res.status).to.equal(204);
  });

  it('returns 403 for a bad pickup secret (and does not consume)', async () => {
    const { app, kv } = makeApp();
    await kv.put(sessionKey('s3'), JSON.stringify(record()), 600);
    const res = await request(app)
      .post('/result')
      .send({ sessionId: 's3', pickup_secret: 'wrong' });
    expect(res.status).to.equal(403);
    expect(await kv.get(sessionKey('s3'))).to.be.a('string'); // still present
  });

  it('returns 404 for an unknown session', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/result')
      .send({ sessionId: 'nope', pickup_secret: PICKUP });
    expect(res.status).to.equal(404);
  });

  it('returns the error payload once when callback recorded an error', async () => {
    const { app, kv } = makeApp();
    await kv.put(
      sessionKey('s4'),
      JSON.stringify(record({ sealedCode: undefined, error: 'access_denied' })),
      600,
    );
    const res = await request(app).post('/result').send({ sessionId: 's4', pickup_secret: PICKUP });
    expect(res.status).to.equal(200);
    expect(res.body.error).to.equal('access_denied');
  });
});
