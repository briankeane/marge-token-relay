import { createRequire } from 'node:module';
import { expect } from 'chai';
import request from 'supertest';
import { buildApp } from '../src/app.js';

// libsodium-wrappers ESM build is broken (missing libsodium.mjs sibling);
// use createRequire to force the CJS path, same as in crypto.ts and crypto.test.ts.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sodium = require('libsodium-wrappers') as typeof import('libsodium-wrappers');
import { loadConfig } from '../src/config.js';
import { MemoryKV } from '../src/lib/kv.js';
import { sessionKey, stateKey, type SessionRecord } from '../src/lib/session.js';
import { initCrypto } from '../src/lib/crypto.js';

describe('GET /callback', () => {
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
    const kv = new MemoryKV();
    return { app: buildApp({ kv, config }), kv };
  }

  function seededRecord(): SessionRecord {
    return {
      consent: { clientId: 'c1', scopes: 'openid', state: 'st1', codeChallenge: 'ch1' },
      pickupHash: 'h',
      botPublicKey: sodium.to_base64(keypair.publicKey, sodium.base64_variants.ORIGINAL),
      status: 'pending',
      createdAt: Date.now(),
    };
  }

  it('seals the code to the bot public key and marks the session complete', async () => {
    const { app, kv } = makeApp();
    await kv.put(sessionKey('sess1'), JSON.stringify(seededRecord()), 600);
    await kv.put(stateKey('st1'), 'sess1', 600);

    const res = await request(app).get('/callback?state=st1&code=auth-code-123');
    expect(res.status).to.equal(200);
    expect(res.text).to.contain('all set');

    const updated = JSON.parse((await kv.get(sessionKey('sess1')))!) as SessionRecord;
    expect(updated.status).to.equal('complete');
    expect(updated.sealedCode).to.be.a('string');

    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(updated.sealedCode!, sodium.base64_variants.ORIGINAL),
      keypair.publicKey,
      keypair.privateKey,
    );
    expect(new TextDecoder().decode(opened)).to.equal('auth-code-123');
    // state index is consumed
    expect(await kv.get(stateKey('st1'))).to.equal(null);
  });

  it('stores the error and renders the error page when Google returns ?error', async () => {
    const { app, kv } = makeApp();
    await kv.put(sessionKey('sess2'), JSON.stringify(seededRecord()), 600);
    await kv.put(stateKey('st1'), 'sess2', 600);

    const res = await request(app).get('/callback?state=st1&error=access_denied');
    expect(res.status).to.equal(200);
    const updated = JSON.parse((await kv.get(sessionKey('sess2')))!) as SessionRecord;
    expect(updated.status).to.equal('complete');
    expect(updated.error).to.equal('access_denied');
    expect(updated.sealedCode).to.equal(undefined);
    // state index is consumed even on the error path (single-use)
    expect(await kv.get(stateKey('st1'))).to.equal(null);
  });

  it('returns 410 when state is unknown/expired', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/callback?state=nope&code=x');
    expect(res.status).to.equal(410);
  });

  it('a replayed callback for an already-consumed state returns 410 (no re-seal)', async () => {
    const { app, kv } = makeApp();
    await kv.put(sessionKey('sess3'), JSON.stringify(seededRecord()), 600);
    await kv.put(stateKey('st1'), 'sess3', 600);

    const first = await request(app).get('/callback?state=st1&code=auth-code-123');
    expect(first.status).to.equal(200);
    const sealedAfterFirst = (JSON.parse((await kv.get(sessionKey('sess3')))!) as SessionRecord)
      .sealedCode;

    // Replay: state was consumed, so the second callback must not touch the session.
    const replay = await request(app).get('/callback?state=st1&code=different-code');
    expect(replay.status).to.equal(410);
    const sealedAfterReplay = (JSON.parse((await kv.get(sessionKey('sess3')))!) as SessionRecord)
      .sealedCode;
    expect(sealedAfterReplay).to.equal(sealedAfterFirst);
  });
});
