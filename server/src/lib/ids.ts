import { randomBytes } from 'node:crypto';

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes base64url, unpadded

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isValidToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value);
}
