import { expect } from 'chai';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MemoryKV } from '../src/lib/kv.js';

function makeApp() {
  const config = loadConfig({
    BASE_URL: 'https://relay.test',
    KV_BACKEND: 'memory',
  } as NodeJS.ProcessEnv);
  const kv = new MemoryKV();
  return { app: buildApp({ kv, config }), kv };
}

// A real X25519 public key is exactly 32 bytes; base64-encode 32 bytes for fixtures.
const validPublicKey = Buffer.alloc(32, 7).toString('base64');

const validBody = {
  consent: {
    clientId: 'client-123',
    scopes: 'openid email',
    state: 'state-abc',
    codeChallenge: 'challenge-xyz',
    loginHint: 'user@example.com',
  },
  pickupHash: 'aGFzaA==',
  botPublicKey: validPublicKey,
};

describe('POST /session', () => {
  it('creates a session and returns sessionId + authorizeUrl', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/session').send(validBody);
    expect(res.status).to.equal(201);
    expect(res.body.sessionId).to.match(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body.authorizeUrl).to.equal(
      `https://relay.test/authorize?session=${res.body.sessionId}`,
    );
  });

  it('stores session by sessionId and indexes by state', async () => {
    const { app, kv } = makeApp();
    const res = await request(app).post('/session').send(validBody);
    const stored = await kv.get(`session:${res.body.sessionId}`);
    expect(stored).to.be.a('string');
    expect(await kv.get('state:state-abc')).to.equal(res.body.sessionId);
  });

  it('rejects a body missing consent fields with 400', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/session').send({ pickupHash: 'x', botPublicKey: 'y' });
    expect(res.status).to.equal(400);
  });

  it('rejects a botPublicKey that does not decode to 32 bytes with 400', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/session')
      .send({ ...validBody, botPublicKey: 'cHVia2V5' }); // "pubkey" -> 6 bytes
    expect(res.status).to.equal(400);
  });

  it('rejects an empty required consent field with 400', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/session')
      .send({ ...validBody, consent: { ...validBody.consent, clientId: '' } });
    expect(res.status).to.equal(400);
  });

  it('rejects a second session reusing the same state with 409', async () => {
    const { app } = makeApp();
    const first = await request(app).post('/session').send(validBody);
    expect(first.status).to.equal(201);
    const second = await request(app).post('/session').send(validBody);
    expect(second.status).to.equal(409);
  });
});
