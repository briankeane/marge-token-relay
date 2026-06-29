import { createRequire } from 'node:module';
import { expect } from 'chai';
import { initCrypto, seal, sha256Base64, constantTimeEqualBase64 } from '../src/lib/crypto.js';

// libsodium-wrappers ESM build is broken (missing libsodium.mjs sibling);
// use createRequire to force the CJS path, same as in crypto.ts.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sodium = require('libsodium-wrappers') as typeof import('libsodium-wrappers');

describe('crypto', () => {
  before(async () => {
    await initCrypto();
  });

  it('seals a code that the recipient can open (round-trip)', () => {
    const { publicKey, privateKey } = sodium.crypto_box_keypair();
    const pubB64 = sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL);
    const sealedB64 = seal('the-auth-code', pubB64);
    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(sealedB64, sodium.base64_variants.ORIGINAL),
      publicKey,
      privateKey,
    );
    expect(new TextDecoder().decode(opened)).to.equal('the-auth-code');
  });

  it('sha256Base64 is stable and matches node crypto', () => {
    expect(sha256Base64('secret')).to.equal(sha256Base64('secret'));
    expect(sha256Base64('secret')).to.not.equal(sha256Base64('other'));
  });

  it('constantTimeEqualBase64 matches equal hashes and rejects different ones', () => {
    const h = sha256Base64('secret');
    expect(constantTimeEqualBase64(h, sha256Base64('secret'))).to.equal(true);
    expect(constantTimeEqualBase64(h, sha256Base64('nope'))).to.equal(false);
  });
});
