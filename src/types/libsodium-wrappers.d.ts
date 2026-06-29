// Minimal ambient declaration for libsodium-wrappers.
// The package ships its own .d.ts in dist/modules/ but does not expose it via
// the "types" field when resolved through the broken ESM "exports" path.
// This shim covers the subset of the API used by src/lib/crypto.ts.

// Top-level namespace declaration so that after
//   import sodium from 'libsodium-wrappers';
// the expression `sodium.KeyPair` resolves as a type.
// TypeScript resolves `X.Y` as a type only when there is a *namespace* named X
// in scope — it does not look inside the type of an import value.  Declaring
// `namespace sodium` here (in global scope, outside any `declare module`) makes
// it available wherever the import is in scope, mirroring the pattern used by
// packages like React whose `@types` expose `React.FC` etc.
declare namespace sodium {
  interface KeyPair {
    keyType: string;
    publicKey: Uint8Array;
    privateKey: Uint8Array;
  }
}

declare module 'libsodium-wrappers' {
  export type Base64Variant = number;

  // Re-export KeyPair from the global namespace so it is also accessible as
  // an import: `import type { KeyPair } from 'libsodium-wrappers'`.
  export type KeyPair = sodium.KeyPair;

  export const base64_variants: {
    ORIGINAL: Base64Variant;
    ORIGINAL_NO_PADDING: Base64Variant;
    URLSAFE: Base64Variant;
    URLSAFE_NO_PADDING: Base64Variant;
  };

  export const ready: Promise<void>;

  export function from_base64(input: string, variant?: Base64Variant): Uint8Array;
  export function to_base64(input: Uint8Array | string, variant?: Base64Variant): string;

  export function crypto_box_keypair(): KeyPair;
  export function crypto_box_seal(
    message: string | Uint8Array,
    recipientPublicKey: Uint8Array,
  ): Uint8Array;
  export function crypto_box_seal_open(
    ciphertext: Uint8Array,
    recipientPublicKey: Uint8Array,
    recipientPrivateKey: Uint8Array,
  ): Uint8Array;

  const sodium: typeof import('libsodium-wrappers');
  export default sodium;
}
