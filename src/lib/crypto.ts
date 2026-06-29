import { createRequire } from 'node:module';
import { createHash, timingSafeEqual } from 'node:crypto';

// The libsodium-wrappers ESM build references a sibling libsodium.mjs that is
// not shipped, causing ERR_MODULE_NOT_FOUND under Node ESM.  Loading via
// createRequire forces the CJS path which ships and works correctly.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sodium = require('libsodium-wrappers') as typeof import('libsodium-wrappers');

export async function initCrypto(): Promise<void> {
  await sodium.ready;
}

export function seal(plaintext: string, recipientPubKeyB64: string): string {
  const pubKey = sodium.from_base64(recipientPubKeyB64, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(plaintext, pubKey);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

// True iff `b64` is a valid recipient key for seal(): it must decode under the
// SAME strict decoder seal() uses (base64_variants.ORIGINAL, which rejects the
// URL-safe `-_` alphabet that Node's lenient decoder silently accepts) and yield
// a 32-byte X25519 key. Validating with the exact decoder seal() uses guarantees
// a key that passes here cannot throw inside seal() later. Requires initCrypto().
export function isValidSealRecipientKey(b64: string): boolean {
  try {
    return sodium.from_base64(b64, sodium.base64_variants.ORIGINAL).length === 32;
  } catch {
    return false;
  }
}

export function sha256Base64(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('base64');
}

export function constantTimeEqualBase64(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'base64');
  const bb = Buffer.from(b, 'base64');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
