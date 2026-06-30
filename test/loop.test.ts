import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { expect } from 'chai';
import request from 'supertest';
import { buildApp } from '../src/app.js';

// libsodium-wrappers ESM build is broken (missing libsodium.mjs sibling);
// force the CJS path via createRequire, same as crypto.ts and the other tests.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sodium = require('libsodium-wrappers') as typeof import('libsodium-wrappers');

import { loadConfig } from '../src/config.js';
import { MemoryKV } from '../src/lib/kv.js';
import { initCrypto } from '../src/lib/crypto.js';

describe('full relay loop (session -> authorize -> callback -> result)', () => {
  let keypair: sodium.KeyPair;

  before(async () => {
    await initCrypto();
    keypair = sodium.crypto_box_keypair();
  });

  function makeApp() {
    const config = loadConfig({
      BASE_URL: 'https://relay.test',
      KV_BACKEND: 'memory',
    } as NodeJS.ProcessEnv);
    return buildApp({ kv: new MemoryKV(), config });
  }

  function botPublicKey(): string {
    return sodium.to_base64(keypair.publicKey, sodium.base64_variants.ORIGINAL);
  }

  it('relays a real sealed code end to end and the bot key opens it', async () => {
    const app = makeApp();
    const pickupSecret = 'pickup-secret-value';
    const pickupHash = createHash('sha256').update(pickupSecret, 'utf8').digest('base64');
    const state = 'loop-state-1';

    // 1. POST /session
    const sessionRes = await request(app)
      .post('/session')
      .send({
        consent: {
          clientId: 'client-loop',
          scopes: 'openid email profile',
          state,
          codeChallenge: 'challenge-loop',
        },
        pickupHash,
        botPublicKey: botPublicKey(),
      });
    expect(sessionRes.status).to.equal(201);
    const { sessionId } = sessionRes.body;
    expect(sessionId).to.match(/^[A-Za-z0-9_-]{43}$/);

    // 2. GET /authorize -> 302 to Google with the right params
    const authRes = await request(app).get(`/authorize?session=${sessionId}`);
    expect(authRes.status).to.equal(302);
    const location = new URL(authRes.headers.location);
    expect(location.origin + location.pathname).to.equal(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(location.searchParams.get('redirect_uri')).to.equal('https://relay.test/callback');
    expect(location.searchParams.get('code_challenge')).to.equal('challenge-loop');
    expect(location.searchParams.get('code_challenge_method')).to.equal('S256');
    expect(location.searchParams.get('state')).to.equal(state);
    expect(location.searchParams.get('client_id')).to.equal('client-loop');

    // 3. GET /callback (Google delivers a fake code) -> 200 success page
    const cbRes = await request(app).get(`/callback?state=${state}&code=fake-auth-code`);
    expect(cbRes.status).to.equal(200);
    expect(cbRes.text).to.contain('all set');

    // 4. POST /result -> 200 with sealedCode
    const resultRes = await request(app)
      .post('/result')
      .send({ sessionId, pickup_secret: pickupSecret });
    expect(resultRes.status).to.equal(200);
    expect(resultRes.body.sealedCode).to.be.a('string');

    // 5. The bot's private key opens the sealed code
    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(resultRes.body.sealedCode, sodium.base64_variants.ORIGINAL),
      keypair.publicKey,
      keypair.privateKey,
    );
    expect(new TextDecoder().decode(opened)).to.equal('fake-auth-code');
  });

  it('relays a Google OAuth error to the bot', async () => {
    const app = makeApp();
    const pickupSecret = 'pickup-secret-2';
    const pickupHash = createHash('sha256').update(pickupSecret, 'utf8').digest('base64');
    const state = 'loop-state-2';

    const sessionRes = await request(app)
      .post('/session')
      .send({
        consent: { clientId: 'c', scopes: 'openid', state, codeChallenge: 'ch' },
        pickupHash,
        botPublicKey: botPublicKey(),
      });
    expect(sessionRes.status).to.equal(201);
    const { sessionId } = sessionRes.body;

    const cbRes = await request(app).get(`/callback?state=${state}&error=access_denied`);
    expect(cbRes.status).to.equal(200);
    expect(cbRes.text).to.contain('Something went wrong');

    const resultRes = await request(app)
      .post('/result')
      .send({ sessionId, pickup_secret: pickupSecret });
    expect(resultRes.status).to.equal(200);
    expect(resultRes.body.error).to.equal('access_denied');
    expect(resultRes.body).to.not.have.property('sealedCode');
  });
});
