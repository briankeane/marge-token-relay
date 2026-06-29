# marge-token-relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tiny Render-hosted Express/TypeScript web app that relays a Google OAuth `code` to an off-network bot, holding only an encrypted, single-use, short-lived code — never tokens or the client secret.

**Architecture:** Plain Express 5 server. Four logic endpoints (`/session`, `/authorize`, `/callback`, `/result`) plus `/healthz`. State lives in a TTL KV (Render Key Value/Redis in prod, in-memory in tests) behind a `{put, get, getAndDelete}` adapter that is injected into the app. The authorization `code` is sealed to the bot's X25519 public key with a libsodium sealed box before storage. Result pages are static HTML files.

**Tech Stack:** Node 20+, TypeScript, Express 5, `libsodium-wrappers`, `redis` (node-redis v4), `express-rate-limit`, `helmet`, Mocha + Chai + Supertest, ESLint + Prettier, CircleCI, Render.

## Global Constraints

- **Never** store or log the OAuth client secret, refresh tokens, or access tokens. This app never does a token exchange.
- **Never log** the authorization `code` or the `pickup_secret`. Logs may contain only the `sessionId` prefix (first 8 chars) + outcome.
- All KV entries TTL ~600s (10 min) and are single-use where consumed.
- `sessionId` and `state` are long random tokens (≥32 bytes), validated before any KV lookup.
- Constant-time compare for the pickup secret hash.
- Standard base64 (`base64_variants.ORIGINAL`) for `botPublicKey` and `sealedCode` on the wire.
- HTTPS is platform-terminated by Render; no TLS code here.
- Crypto via `libsodium-wrappers` only — do not hand-roll crypto.
- Keep it boring and tiny: no DB, no token exchange, no Google API calls, no SMS, no user accounts.

---

### Task 1: Project scaffold, tooling, config, and `/healthz`

**Files:**
- Create: `package.json`, `tsconfig.json`, `.eslintrc.json`, `.prettierrc`, `.mocharc.json`, `.gitignore`
- Create: `src/server.ts`, `src/app.ts`, `src/config.ts`, `src/api/health.ts`, `src/middleware/error.ts`
- Test: `test/health.test.ts`, `test/config.test.ts`

**Interfaces:**
- Produces: `buildApp(deps: { kv: KV; config: Config }): Express` in `src/app.ts` (in this task `kv` is optional/unused; added to signature now so later tasks just consume it). `loadConfig(env: NodeJS.ProcessEnv): Config` in `src/config.ts` where `Config = { baseUrl: string; redisUrl?: string; kvBackend: 'redis' | 'memory'; googleAuthEndpoint: string; sessionTtlSeconds: number; port: number }`.

- [ ] **Step 1: Initialize package.json**

```json
{
  "name": "marge-token-relay",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "dev": "tsx watch src/server.ts",
    "lint": "eslint . --ext .ts && prettier --check \"**/*.ts\"",
    "test": "mocha"
  },
  "dependencies": {
    "express": "^5.0.0",
    "helmet": "^8.0.0",
    "express-rate-limit": "^7.4.0",
    "libsodium-wrappers": "^0.7.15",
    "redis": "^4.7.0"
  },
  "devDependencies": {
    "@types/chai": "^4.3.0",
    "@types/express": "^5.0.0",
    "@types/mocha": "^10.0.0",
    "@types/node": "^20.0.0",
    "@types/supertest": "^6.0.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "chai": "^4.5.0",
    "eslint": "^8.57.0",
    "mocha": "^10.7.0",
    "prettier": "^3.3.0",
    "supertest": "^7.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Add tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Add lint/format/test/ignore configs**

`.eslintrc.json`:
```json
{
  "root": true,
  "parser": "@typescript-eslint/parser",
  "plugins": ["@typescript-eslint"],
  "extends": ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  "parserOptions": { "ecmaVersion": 2022, "sourceType": "module" },
  "env": { "node": true, "es2022": true },
  "ignorePatterns": ["dist", "node_modules"]
}
```

`.prettierrc`:
```json
{ "singleQuote": true, "semi": true, "printWidth": 100, "trailingComma": "all" }
```

`.mocharc.json`:
```json
{
  "extension": ["ts"],
  "spec": "test/**/*.test.ts",
  "loader": "tsx",
  "timeout": 10000
}
```

`.gitignore`:
```
node_modules
dist
.env
*.log
```

- [ ] **Step 4: Write the failing tests**

`test/config.test.ts`:
```typescript
import { expect } from 'chai';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('parses env with defaults', () => {
    const cfg = loadConfig({
      BASE_URL: 'https://relay.example.com',
      KV_BACKEND: 'memory',
    } as NodeJS.ProcessEnv);
    expect(cfg.baseUrl).to.equal('https://relay.example.com');
    expect(cfg.kvBackend).to.equal('memory');
    expect(cfg.sessionTtlSeconds).to.equal(600);
    expect(cfg.googleAuthEndpoint).to.contain('accounts.google.com');
  });

  it('throws when BASE_URL is missing', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).to.throw(/BASE_URL/);
  });
});
```

`test/health.test.ts`:
```typescript
import { expect } from 'chai';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('GET /healthz', () => {
  it('returns 200', async () => {
    const config = loadConfig({ BASE_URL: 'https://x.test', KV_BACKEND: 'memory' } as NodeJS.ProcessEnv);
    const app = buildApp({ kv: undefined as never, config });
    const res = await request(app).get('/healthz');
    expect(res.status).to.equal(200);
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot find `../src/config.js` / `../src/app.js`.

- [ ] **Step 6: Implement config.ts**

```typescript
export type KvBackend = 'redis' | 'memory';

export interface Config {
  baseUrl: string;
  redisUrl?: string;
  kvBackend: KvBackend;
  googleAuthEndpoint: string;
  sessionTtlSeconds: number;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const baseUrl = env.BASE_URL;
  if (!baseUrl) throw new Error('BASE_URL is required');
  const kvBackend: KvBackend = env.KV_BACKEND === 'memory' ? 'memory' : 'redis';
  if (kvBackend === 'redis' && !env.REDIS_URL) {
    throw new Error('REDIS_URL is required when KV_BACKEND=redis');
  }
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    redisUrl: env.REDIS_URL,
    kvBackend,
    googleAuthEndpoint:
      env.GOOGLE_AUTH_ENDPOINT ?? 'https://accounts.google.com/o/oauth2/v2/auth',
    sessionTtlSeconds: Number(env.SESSION_TTL_SECONDS ?? 600),
    port: Number(env.PORT ?? 3000),
  };
}
```

- [ ] **Step 7: Implement error middleware, health route, app, server**

`src/middleware/error.ts`:
```typescript
import type { ErrorRequestHandler } from 'express';

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  // Never log request bodies, codes, or secrets — only a generic message.
  console.error('request_error', err instanceof Error ? err.message : 'unknown');
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal_error' });
};
```

`src/api/health.ts`:
```typescript
import { Router } from 'express';

export const healthRouter = Router();
healthRouter.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});
```

`src/app.ts`:
```typescript
import express, { type Express } from 'express';
import type { KV } from './lib/kv.js';
import type { Config } from './config.js';
import { healthRouter } from './api/health.js';
import { errorHandler } from './middleware/error.js';

export interface AppDeps {
  kv: KV;
  config: Config;
}

export function buildApp(_deps: AppDeps): Express {
  const app = express();
  app.use(express.json());
  app.use(healthRouter);
  app.use(errorHandler);
  return app;
}
```

> Note: `import type { KV } from './lib/kv.js'` resolves in Task 2. Until then, add a temporary `export interface KV {}` stub in `src/lib/kv.ts` so this task compiles standalone. Task 2 replaces the stub.

`src/server.ts`:
```typescript
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createKv } from './lib/kv.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const kv = await createKv(config);
  const app = buildApp({ kv, config });
  app.listen(config.port, () => {
    console.log(`marge-token-relay listening on :${config.port}`);
  });
}

main().catch((err) => {
  console.error('startup_failed', err instanceof Error ? err.message : 'unknown');
  process.exit(1);
});
```

> Note: `createKv` resolves in Task 2. Add a temporary stub `export async function createKv(_c: Config): Promise<KV> { throw new Error('not implemented'); }` in `src/lib/kv.ts` so the build passes; Task 2 implements it.

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (config + health).

- [ ] **Step 9: Run lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: scaffold project, config, health endpoint"
```

---

### Task 2: KV adapter (interface + in-memory + Redis)

**Files:**
- Modify: `src/lib/kv.ts` (replace the Task 1 stubs)
- Test: `test/kv.test.ts`

**Interfaces:**
- Consumes: `Config` from `src/config.ts`.
- Produces:
  - `interface KV { put(key: string, val: string, ttlSeconds: number): Promise<void>; get(key: string): Promise<string | null>; getAndDelete(key: string): Promise<string | null>; }`
  - `class MemoryKV implements KV` (constructor takes no args).
  - `createKv(config: Config): Promise<KV>` — returns `MemoryKV` when `config.kvBackend === 'memory'`, else a Redis-backed KV connected to `config.redisUrl`.

- [ ] **Step 1: Write the failing test**

`test/kv.test.ts`:
```typescript
import { expect } from 'chai';
import { MemoryKV } from '../src/lib/kv.js';

describe('MemoryKV', () => {
  it('puts and gets a value', async () => {
    const kv = new MemoryKV();
    await kv.put('k', 'v', 600);
    expect(await kv.get('k')).to.equal('v');
  });

  it('returns null for missing keys', async () => {
    const kv = new MemoryKV();
    expect(await kv.get('nope')).to.equal(null);
  });

  it('expires entries after ttl', async () => {
    const kv = new MemoryKV();
    await kv.put('k', 'v', 0); // already-expired
    expect(await kv.get('k')).to.equal(null);
  });

  it('getAndDelete returns once then null', async () => {
    const kv = new MemoryKV();
    await kv.put('k', 'v', 600);
    expect(await kv.getAndDelete('k')).to.equal('v');
    expect(await kv.getAndDelete('k')).to.equal(null);
    expect(await kv.get('k')).to.equal(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/kv.test.ts`
Expected: FAIL — `MemoryKV` is not exported.

- [ ] **Step 3: Implement kv.ts**

```typescript
import { createClient, type RedisClientType } from 'redis';
import type { Config } from '../config.js';

export interface KV {
  put(key: string, val: string, ttlSeconds: number): Promise<void>;
  get(key: string): Promise<string | null>;
  getAndDelete(key: string): Promise<string | null>;
}

interface Entry {
  val: string;
  expiresAt: number;
}

export class MemoryKV implements KV {
  private store = new Map<string, Entry>();

  async put(key: string, val: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, { val, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.val;
  }

  async getAndDelete(key: string): Promise<string | null> {
    const val = await this.get(key);
    this.store.delete(key);
    return val;
  }
}

export class RedisKV implements KV {
  constructor(private client: RedisClientType) {}

  async put(key: string, val: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, val, { EX: ttlSeconds });
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async getAndDelete(key: string): Promise<string | null> {
    return this.client.getDel(key);
  }
}

export async function createKv(config: Config): Promise<KV> {
  if (config.kvBackend === 'memory') return new MemoryKV();
  const client: RedisClientType = createClient({ url: config.redisUrl });
  client.on('error', (e) => console.error('redis_error', e instanceof Error ? e.message : 'unknown'));
  await client.connect();
  return new RedisKV(client);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all KV tests + Task 1 tests).

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add -A
git commit -m "feat: KV adapter with in-memory and Redis backends"
```

---

### Task 3: Crypto lib (sealed box, sha256, constant-time compare)

**Files:**
- Create: `src/lib/crypto.ts`
- Test: `test/crypto.test.ts`

**Interfaces:**
- Produces:
  - `initCrypto(): Promise<void>` — awaits `sodium.ready`; must be called once at startup before `seal`.
  - `seal(plaintext: string, recipientPubKeyB64: string): string` — returns standard-base64 sealed-box ciphertext.
  - `sha256Base64(input: string): string` — base64 of the SHA-256 digest.
  - `constantTimeEqualBase64(a: string, b: string): boolean` — constant-time compare of two base64 digests.

- [ ] **Step 1: Write the failing test**

`test/crypto.test.ts`:
```typescript
import { expect } from 'chai';
import sodium from 'libsodium-wrappers';
import {
  initCrypto,
  seal,
  sha256Base64,
  constantTimeEqualBase64,
} from '../src/lib/crypto.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/crypto.test.ts`
Expected: FAIL — `../src/lib/crypto.js` not found.

- [ ] **Step 3: Implement crypto.ts**

```typescript
import sodium from 'libsodium-wrappers';
import { createHash, timingSafeEqual } from 'node:crypto';

export async function initCrypto(): Promise<void> {
  await sodium.ready;
}

export function seal(plaintext: string, recipientPubKeyB64: string): string {
  const pubKey = sodium.from_base64(recipientPubKeyB64, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(plaintext, pubKey);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add -A
git commit -m "feat: libsodium sealed-box crypto + hashing helpers"
```

---

### Task 4: ID generation & validation

**Files:**
- Create: `src/lib/ids.ts`
- Test: `test/ids.test.ts`

**Interfaces:**
- Produces:
  - `newToken(): string` — 32 random bytes, base64url-encoded.
  - `isValidToken(value: unknown): value is string` — true for a base64url string of the expected length (used to validate `sessionId` and `state` before KV lookups).

- [ ] **Step 1: Write the failing test**

`test/ids.test.ts`:
```typescript
import { expect } from 'chai';
import { newToken, isValidToken } from '../src/lib/ids.js';

describe('ids', () => {
  it('generates unguessable base64url tokens', () => {
    const a = newToken();
    const b = newToken();
    expect(a).to.not.equal(b);
    expect(a).to.match(/^[A-Za-z0-9_-]{43}$/); // 32 bytes -> 43 base64url chars
  });

  it('validates good tokens and rejects bad input', () => {
    expect(isValidToken(newToken())).to.equal(true);
    expect(isValidToken('short')).to.equal(false);
    expect(isValidToken('has spaces and !')).to.equal(false);
    expect(isValidToken(123)).to.equal(false);
    expect(isValidToken(undefined)).to.equal(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/ids.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement ids.ts**

```typescript
import { randomBytes } from 'node:crypto';

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes base64url, unpadded

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isValidToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add -A
git commit -m "feat: random token generation and validation"
```

---

### Task 5: Google consent URL builder

**Files:**
- Create: `src/lib/google.ts`
- Test: `test/google.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (pure function).
- Produces:
  - `interface ConsentParams { clientId: string; scopes: string; state: string; codeChallenge: string; loginHint?: string; }`
  - `buildConsentUrl(args: { endpoint: string; redirectUri: string; consent: ConsentParams }): string`

- [ ] **Step 1: Write the failing test**

`test/google.test.ts`:
```typescript
import { expect } from 'chai';
import { buildConsentUrl } from '../src/lib/google.js';

describe('buildConsentUrl', () => {
  const base = {
    endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    redirectUri: 'https://relay.test/callback',
    consent: {
      clientId: 'client-123',
      scopes: 'openid email https://www.googleapis.com/auth/calendar',
      state: 'state-abc',
      codeChallenge: 'challenge-xyz',
      loginHint: 'user@example.com',
    },
  };

  it('builds a Google consent URL with all required params', () => {
    const url = new URL(buildConsentUrl(base));
    expect(url.origin + url.pathname).to.equal('https://accounts.google.com/o/oauth2/v2/auth');
    const p = url.searchParams;
    expect(p.get('client_id')).to.equal('client-123');
    expect(p.get('redirect_uri')).to.equal('https://relay.test/callback');
    expect(p.get('response_type')).to.equal('code');
    expect(p.get('scope')).to.equal('openid email https://www.googleapis.com/auth/calendar');
    expect(p.get('state')).to.equal('state-abc');
    expect(p.get('code_challenge')).to.equal('challenge-xyz');
    expect(p.get('code_challenge_method')).to.equal('S256');
    expect(p.get('access_type')).to.equal('offline');
    expect(p.get('prompt')).to.equal('consent');
    expect(p.get('login_hint')).to.equal('user@example.com');
  });

  it('omits login_hint when not provided', () => {
    const url = new URL(buildConsentUrl({ ...base, consent: { ...base.consent, loginHint: undefined } }));
    expect(url.searchParams.has('login_hint')).to.equal(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/google.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement google.ts**

```typescript
export interface ConsentParams {
  clientId: string;
  scopes: string;
  state: string;
  codeChallenge: string;
  loginHint?: string;
}

export function buildConsentUrl(args: {
  endpoint: string;
  redirectUri: string;
  consent: ConsentParams;
}): string {
  const { endpoint, redirectUri, consent } = args;
  const url = new URL(endpoint);
  url.searchParams.set('client_id', consent.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', consent.scopes);
  url.searchParams.set('state', consent.state);
  url.searchParams.set('code_challenge', consent.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  if (consent.loginHint) url.searchParams.set('login_hint', consent.loginHint);
  return url.toString();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add -A
git commit -m "feat: Google consent URL builder"
```

---

### Task 6: Session model + `POST /session`

**Files:**
- Create: `src/lib/session.ts` (shared session types + KV key helpers, consumed by Tasks 7–9)
- Create: `src/api/session.ts`
- Modify: `src/app.ts` (mount the session router)
- Test: `test/session.test.ts`

**Interfaces:**
- Consumes: `KV`, `ConsentParams`, `newToken`, `isValidToken`, `Config`.
- Produces:
  - In `src/lib/session.ts`:
    - `type SessionStatus = 'pending' | 'complete';`
    - `interface SessionRecord { consent: ConsentParams; pickupHash: string; botPublicKey: string; status: SessionStatus; sealedCode?: string; error?: string; createdAt: number; }`
    - `sessionKey(id: string): string` → `` `session:${id}` ``
    - `stateKey(state: string): string` → `` `state:${state}` ``
  - In `src/api/session.ts`: `sessionRouter(deps: AppDeps): Router` mounting `POST /session`.
- The `buildApp` change: `app.use(sessionRouter(deps))`.

- [ ] **Step 1: Write the failing test**

`test/session.test.ts`:
```typescript
import { expect } from 'chai';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MemoryKV } from '../src/lib/kv.js';

function makeApp() {
  const config = loadConfig({ BASE_URL: 'https://relay.test', KV_BACKEND: 'memory' } as NodeJS.ProcessEnv);
  const kv = new MemoryKV();
  return { app: buildApp({ kv, config }), kv };
}

const validBody = {
  consent: {
    clientId: 'client-123',
    scopes: 'openid email',
    state: 'state-abc',
    codeChallenge: 'challenge-xyz',
    loginHint: 'user@example.com',
  },
  pickupHash: 'aGFzaA==',
  botPublicKey: 'cHVia2V5',
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/session.test.ts`
Expected: FAIL — `/session` returns 404 (route not mounted).

- [ ] **Step 3: Implement session model**

`src/lib/session.ts`:
```typescript
import type { ConsentParams } from './google.js';

export type SessionStatus = 'pending' | 'complete';

export interface SessionRecord {
  consent: ConsentParams;
  pickupHash: string;
  botPublicKey: string;
  status: SessionStatus;
  sealedCode?: string;
  error?: string;
  createdAt: number;
}

export const sessionKey = (id: string): string => `session:${id}`;
export const stateKey = (state: string): string => `state:${state}`;
```

- [ ] **Step 4: Implement the session route**

`src/api/session.ts`:
```typescript
import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { newToken } from '../lib/ids.js';
import { sessionKey, stateKey, type SessionRecord } from '../lib/session.js';
import type { ConsentParams } from '../lib/google.js';

function parseConsent(body: unknown): ConsentParams | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const c = b.consent as Record<string, unknown> | undefined;
  if (!c) return null;
  const { clientId, scopes, state, codeChallenge, loginHint } = c;
  if (
    typeof clientId !== 'string' ||
    typeof scopes !== 'string' ||
    typeof state !== 'string' ||
    typeof codeChallenge !== 'string' ||
    (loginHint !== undefined && typeof loginHint !== 'string')
  ) {
    return null;
  }
  return { clientId, scopes, state, codeChallenge, loginHint };
}

export function sessionRouter(deps: AppDeps): Router {
  const router = Router();
  router.post('/session', async (req, res) => {
    const consent = parseConsent(req.body);
    const pickupHash = (req.body as Record<string, unknown>)?.pickupHash;
    const botPublicKey = (req.body as Record<string, unknown>)?.botPublicKey;
    if (!consent || typeof pickupHash !== 'string' || typeof botPublicKey !== 'string') {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const sessionId = newToken();
    const record: SessionRecord = {
      consent,
      pickupHash,
      botPublicKey,
      status: 'pending',
      createdAt: Date.now(),
    };
    const ttl = deps.config.sessionTtlSeconds;
    await deps.kv.put(sessionKey(sessionId), JSON.stringify(record), ttl);
    await deps.kv.put(stateKey(consent.state), sessionId, ttl);

    res.status(201).json({
      sessionId,
      authorizeUrl: `${deps.config.baseUrl}/authorize?session=${sessionId}`,
    });
  });
  return router;
}
```

- [ ] **Step 5: Mount the router in app.ts**

In `src/app.ts`, change `buildApp` to mount it (replace the body):
```typescript
import express, { type Express } from 'express';
import type { KV } from './lib/kv.js';
import type { Config } from './config.js';
import { healthRouter } from './api/health.js';
import { sessionRouter } from './api/session.js';
import { errorHandler } from './middleware/error.js';

export interface AppDeps {
  kv: KV;
  config: Config;
}

export function buildApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json());
  app.use(healthRouter);
  app.use(sessionRouter(deps));
  app.use(errorHandler);
  return app;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Lint and commit**

```bash
npm run lint
git add -A
git commit -m "feat: POST /session creates and stores session"
```

---

### Task 7: `GET /authorize` + `expired.html`

**Files:**
- Create: `src/api/authorize.ts`, `src/public/expired.html`
- Modify: `src/app.ts` (mount authorize router; serve static dir)
- Test: `test/authorize.test.ts`

**Interfaces:**
- Consumes: `KV`, `sessionKey`, `SessionRecord`, `buildConsentUrl`, `isValidToken`, `Config`.
- Produces: `authorizeRouter(deps: AppDeps): Router` mounting `GET /authorize`.

- [ ] **Step 1: Write the failing test**

`test/authorize.test.ts`:
```typescript
import { expect } from 'chai';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MemoryKV } from '../src/lib/kv.js';
import { sessionKey, type SessionRecord } from '../src/lib/session.js';
import { newToken } from '../src/lib/ids.js';

function makeApp() {
  const config = loadConfig({ BASE_URL: 'https://relay.test', KV_BACKEND: 'memory' } as NodeJS.ProcessEnv);
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
    expect((await request(app).get('/authorize?session=not-a-token').redirects(0)).status).to.equal(400);
  });
});
```

> Validation split: `/authorize`'s `session` param is a `sessionId` *we* minted, so it is validated with `isValidToken` (reject malformed → 400, before any KV lookup). A well-formed token that simply isn't in the KV is treated as expired → 410. (`state` in `/callback` is bot-chosen and has no fixed shape, so it gets only a non-empty-string guard.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/authorize.test.ts`
Expected: FAIL — `/authorize` 404.

- [ ] **Step 3: Add the static file**

`src/public/expired.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Link expired</title>
  </head>
  <body>
    <main>
      <h1>This link has expired</h1>
      <p>Please return to your conversation and request a new link.</p>
    </main>
  </body>
</html>
```

- [ ] **Step 4: Implement the authorize route**

`src/api/authorize.ts`:
```typescript
import { Router } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppDeps } from '../app.js';
import { sessionKey, type SessionRecord } from '../lib/session.js';
import { buildConsentUrl } from '../lib/google.js';
import { isValidToken } from '../lib/ids.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function authorizeRouter(deps: AppDeps): Router {
  const router = Router();
  router.get('/authorize', async (req, res) => {
    const session = req.query.session;
    if (!isValidToken(session)) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const raw = await deps.kv.get(sessionKey(session));
    if (!raw) {
      res.status(410).sendFile(path.join(publicDir, 'expired.html'));
      return;
    }
    const record = JSON.parse(raw) as SessionRecord;
    const url = buildConsentUrl({
      endpoint: deps.config.googleAuthEndpoint,
      redirectUri: `${deps.config.baseUrl}/callback`,
      consent: record.consent,
    });
    res.redirect(302, url);
  });
  return router;
}
```

- [ ] **Step 5: Mount router in app.ts**

In `src/app.ts`, add the import and `app.use(authorizeRouter(deps));` after the session router:
```typescript
import { authorizeRouter } from './api/authorize.js';
// ...
  app.use(sessionRouter(deps));
  app.use(authorizeRouter(deps));
```

- [ ] **Step 6: Run tests and lint**

Run: `npm test && npm run lint`
Expected: PASS, no lint errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: GET /authorize redirects to Google consent"
```

---

### Task 8: `GET /callback` (seal + store) + result pages

**Files:**
- Create: `src/api/callback.ts`, `src/public/success.html`, `src/public/error.html`
- Modify: `src/app.ts` (mount callback router), `src/server.ts` (call `initCrypto()` at startup)
- Test: `test/callback.test.ts`

**Interfaces:**
- Consumes: `KV`, `stateKey`, `sessionKey`, `SessionRecord`, `seal`, `initCrypto`, `Config`.
- Produces: `callbackRouter(deps: AppDeps): Router` mounting `GET /callback`.

- [ ] **Step 1: Write the failing test**

`test/callback.test.ts`:
```typescript
import { expect } from 'chai';
import request from 'supertest';
import sodium from 'libsodium-wrappers';
import { buildApp } from '../src/app.js';
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
    const config = loadConfig({ BASE_URL: 'https://relay.test', KV_BACKEND: 'memory' } as NodeJS.ProcessEnv);
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
  });

  it('returns 410 when state is unknown/expired', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/callback?state=nope&code=x');
    expect(res.status).to.equal(410);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/callback.test.ts`
Expected: FAIL — `/callback` 404.

- [ ] **Step 3: Add result pages**

`src/public/success.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>All set</title>
  </head>
  <body>
    <main>
      <h1>You're all set</h1>
      <p>You can return to your conversation now.</p>
    </main>
  </body>
</html>
```

`src/public/error.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Something went wrong</title>
  </head>
  <body>
    <main>
      <h1>Something went wrong</h1>
      <p>Please return to your conversation and try again.</p>
    </main>
  </body>
</html>
```

- [ ] **Step 4: Implement the callback route**

`src/api/callback.ts`:
```typescript
import { Router } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppDeps } from '../app.js';
import { sessionKey, stateKey, type SessionRecord } from '../lib/session.js';
import { seal } from '../lib/crypto.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function callbackRouter(deps: AppDeps): Router {
  const router = Router();
  router.get('/callback', async (req, res) => {
    const state = req.query.state;
    if (typeof state !== 'string' || state.length === 0) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const sessionId = await deps.kv.get(stateKey(state));
    if (!sessionId) {
      res.status(410).sendFile(path.join(publicDir, 'error.html'));
      return;
    }
    const raw = await deps.kv.get(sessionKey(sessionId));
    if (!raw) {
      res.status(410).sendFile(path.join(publicDir, 'error.html'));
      return;
    }
    const record = JSON.parse(raw) as SessionRecord;

    const error = typeof req.query.error === 'string' ? req.query.error : undefined;
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;

    record.status = 'complete';
    if (error) {
      record.error = error;
    } else if (code) {
      // NEVER log the code.
      record.sealedCode = seal(code, record.botPublicKey);
    } else {
      record.error = 'missing_code';
    }

    const ttl = deps.config.sessionTtlSeconds;
    await deps.kv.put(sessionKey(sessionId), JSON.stringify(record), ttl);
    await deps.kv.getAndDelete(stateKey(state)); // state is spent

    const page = record.error ? 'error.html' : 'success.html';
    res.status(200).sendFile(path.join(publicDir, page));
  });
  return router;
}
```

- [ ] **Step 5: Mount router + init crypto at startup**

In `src/app.ts` add `import { callbackRouter } from './api/callback.js';` and `app.use(callbackRouter(deps));` after the authorize router.

In `src/server.ts`, call `initCrypto()` before building the app:
```typescript
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createKv } from './lib/kv.js';
import { initCrypto } from './lib/crypto.js';

async function main(): Promise<void> {
  await initCrypto();
  const config = loadConfig(process.env);
  const kv = await createKv(config);
  const app = buildApp({ kv, config });
  app.listen(config.port, () => {
    console.log(`marge-token-relay listening on :${config.port}`);
  });
}

main().catch((err) => {
  console.error('startup_failed', err instanceof Error ? err.message : 'unknown');
  process.exit(1);
});
```

- [ ] **Step 6: Run tests and lint**

Run: `npm test && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: GET /callback seals code and renders result page"
```

---

### Task 9: `POST /result` (single-use pickup)

**Files:**
- Create: `src/api/result.ts`
- Modify: `src/app.ts` (mount result router)
- Test: `test/result.test.ts`

**Interfaces:**
- Consumes: `KV`, `sessionKey`, `SessionRecord`, `sha256Base64`, `constantTimeEqualBase64`, `Config`.
- Produces: `resultRouter(deps: AppDeps): Router` mounting `POST /result`.

- [ ] **Step 1: Write the failing test**

`test/result.test.ts`:
```typescript
import { expect } from 'chai';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MemoryKV } from '../src/lib/kv.js';
import { sessionKey, type SessionRecord } from '../src/lib/session.js';
import { sha256Base64, initCrypto } from '../src/lib/crypto.js';

const PICKUP = 'super-secret-pickup';

function makeApp() {
  const config = loadConfig({ BASE_URL: 'https://relay.test', KV_BACKEND: 'memory' } as NodeJS.ProcessEnv);
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
  before(async () => { await initCrypto(); });

  it('returns the sealed code once, then 404 (single-use)', async () => {
    const { app, kv } = makeApp();
    await kv.put(sessionKey('s1'), JSON.stringify(record()), 600);

    const first = await request(app).post('/result').send({ sessionId: 's1', pickup_secret: PICKUP });
    expect(first.status).to.equal(200);
    expect(first.body.sealedCode).to.equal('sealed-code-b64');

    const second = await request(app).post('/result').send({ sessionId: 's1', pickup_secret: PICKUP });
    expect(second.status).to.equal(404);
  });

  it('returns 204 while still pending', async () => {
    const { app, kv } = makeApp();
    await kv.put(sessionKey('s2'), JSON.stringify(record({ status: 'pending', sealedCode: undefined })), 600);
    const res = await request(app).post('/result').send({ sessionId: 's2', pickup_secret: PICKUP });
    expect(res.status).to.equal(204);
  });

  it('returns 403 for a bad pickup secret (and does not consume)', async () => {
    const { app, kv } = makeApp();
    await kv.put(sessionKey('s3'), JSON.stringify(record()), 600);
    const res = await request(app).post('/result').send({ sessionId: 's3', pickup_secret: 'wrong' });
    expect(res.status).to.equal(403);
    expect(await kv.get(sessionKey('s3'))).to.be.a('string'); // still present
  });

  it('returns 404 for an unknown session', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/result').send({ sessionId: 'nope', pickup_secret: PICKUP });
    expect(res.status).to.equal(404);
  });

  it('returns the error payload once when callback recorded an error', async () => {
    const { app, kv } = makeApp();
    await kv.put(sessionKey('s4'), JSON.stringify(record({ sealedCode: undefined, error: 'access_denied' })), 600);
    const res = await request(app).post('/result').send({ sessionId: 's4', pickup_secret: PICKUP });
    expect(res.status).to.equal(200);
    expect(res.body.error).to.equal('access_denied');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/result.test.ts`
Expected: FAIL — `/result` 404.

- [ ] **Step 3: Implement the result route**

`src/api/result.ts`:
```typescript
import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { sessionKey, type SessionRecord } from '../lib/session.js';
import { sha256Base64, constantTimeEqualBase64 } from '../lib/crypto.js';

export function resultRouter(deps: AppDeps): Router {
  const router = Router();
  router.post('/result', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = body.sessionId;
    const pickupSecret = body.pickup_secret;
    if (typeof sessionId !== 'string' || typeof pickupSecret !== 'string') {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const raw = await deps.kv.get(sessionKey(sessionId));
    if (!raw) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const record = JSON.parse(raw) as SessionRecord;

    // Constant-time compare of the pickup secret hash before anything else.
    if (!constantTimeEqualBase64(record.pickupHash, sha256Base64(pickupSecret))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    if (record.status !== 'complete') {
      res.status(204).end();
      return;
    }

    // Single-use: consume the session now.
    await deps.kv.getAndDelete(sessionKey(sessionId));
    if (record.error) {
      res.status(200).json({ error: record.error });
    } else {
      res.status(200).json({ sealedCode: record.sealedCode });
    }
  });
  return router;
}
```

- [ ] **Step 4: Mount router in app.ts**

Add `import { resultRouter } from './api/result.js';` and `app.use(resultRouter(deps));` after the callback router (before `errorHandler`).

- [ ] **Step 5: Run tests and lint**

Run: `npm test && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: POST /result single-use sealed pickup"
```

---

### Task 10: Security hardening (helmet + rate limiting)

**Files:**
- Modify: `src/app.ts` (add helmet + rate limiters on `/session` and `/result`)
- Test: `test/ratelimit.test.ts`

**Interfaces:**
- Consumes: existing `buildApp`. No new exports.
- Note: rate-limit configuration must be tunable so tests can trigger it without 100 requests. Add an optional field to `AppDeps`: `rateLimit?: { windowMs: number; max: number }` defaulting to `{ windowMs: 60_000, max: 30 }`.

- [ ] **Step 1: Write the failing test**

`test/ratelimit.test.ts`:
```typescript
import { expect } from 'chai';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MemoryKV } from '../src/lib/kv.js';

describe('rate limiting', () => {
  it('429s on /result after exceeding the configured max', async () => {
    const config = loadConfig({ BASE_URL: 'https://relay.test', KV_BACKEND: 'memory' } as NodeJS.ProcessEnv);
    const app = buildApp({ kv: new MemoryKV(), config, rateLimit: { windowMs: 60_000, max: 2 } });

    const send = () => request(app).post('/result').send({ sessionId: 'x', pickup_secret: 'y' });
    await send();
    await send();
    const third = await send();
    expect(third.status).to.equal(429);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/ratelimit.test.ts`
Expected: FAIL — third request returns 404, not 429.

- [ ] **Step 3: Add helmet + rate limiters to app.ts**

Update `src/app.ts`:
```typescript
import express, { type Express } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import type { KV } from './lib/kv.js';
import type { Config } from './config.js';
import { healthRouter } from './api/health.js';
import { sessionRouter } from './api/session.js';
import { authorizeRouter } from './api/authorize.js';
import { callbackRouter } from './api/callback.js';
import { resultRouter } from './api/result.js';
import { errorHandler } from './middleware/error.js';

export interface AppDeps {
  kv: KV;
  config: Config;
  rateLimit?: { windowMs: number; max: number };
}

export function buildApp(deps: AppDeps): Express {
  const app = express();
  app.use(helmet());
  app.use(express.json());

  const { windowMs, max } = deps.rateLimit ?? { windowMs: 60_000, max: 30 };
  const limiter = rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false });

  app.use(healthRouter);
  app.use('/session', limiter);
  app.use('/result', limiter);
  app.use(sessionRouter(deps));
  app.use(authorizeRouter(deps));
  app.use(callbackRouter(deps));
  app.use(resultRouter(deps));
  app.use(errorHandler);
  return app;
}
```

> Note: a single shared `limiter` instance applied via two `app.use` mounts keeps one counter keyed by IP+route. This is fine for a single Render instance.

- [ ] **Step 4: Run tests and lint**

Run: `npm test && npm run lint`
Expected: PASS (all suites green).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: helmet headers + rate limiting on /session and /result"
```

---

### Task 11: Deploy config, CI, and README

**Files:**
- Create: `render.yaml`, `.env.example`, `.circleci/config.yml`, `README.md`

**Interfaces:** none (config + docs).

- [ ] **Step 1: Add render.yaml**

```yaml
services:
  - type: web
    name: marge-token-relay
    runtime: node
    plan: free
    buildCommand: npm ci && npm run build
    startCommand: npm start
    healthCheckPath: /healthz
    envVars:
      - key: KV_BACKEND
        value: redis
      - key: BASE_URL
        sync: false
      - key: GOOGLE_AUTH_ENDPOINT
        value: https://accounts.google.com/o/oauth2/v2/auth
      - key: SESSION_TTL_SECONDS
        value: "600"
      - key: REDIS_URL
        fromService:
          name: marge-token-relay-kv
          type: keyvalue
          property: connectionString

  - type: keyvalue
    name: marge-token-relay-kv
    plan: free
    ipAllowList: []
```

- [ ] **Step 2: Add .env.example**

```
# Public URL of this deployed app (no trailing slash)
BASE_URL=https://marge-token-relay.onrender.com

# Storage backend: "redis" (prod) or "memory" (local/tests)
KV_BACKEND=redis
REDIS_URL=redis://localhost:6379

# Google OAuth 2.0 authorization endpoint
GOOGLE_AUTH_ENDPOINT=https://accounts.google.com/o/oauth2/v2/auth

# Session/entry TTL in seconds (~10 minutes)
SESSION_TTL_SECONDS=600

# Server port (Render provides PORT automatically)
PORT=3000
```

- [ ] **Step 3: Add CircleCI config**

`.circleci/config.yml`:
```yaml
version: 2.1

jobs:
  lint-and-test:
    docker:
      - image: cimg/node:20.17
    steps:
      - checkout
      - restore_cache:
          keys:
            - deps-v1-{{ checksum "package-lock.json" }}
      - run: npm ci
      - save_cache:
          key: deps-v1-{{ checksum "package-lock.json" }}
          paths:
            - ~/.npm
      - run: npm run lint
      - run: npm test
      - run: npm run build

workflows:
  ci:
    jobs:
      - lint-and-test
```

- [ ] **Step 4: Write README.md**

Write `README.md` documenting the full bot-side contract. It MUST include:
- One-paragraph purpose + the security model (never holds tokens/secret; holds only a sealed, single-use, short-lived code).
- The 5-step flow (`POST /session` → text `authorizeUrl` → user `GET /authorize` → Google `GET /callback` → bot `POST /result`).
- A field table for every request/response body:
  - `POST /session` request: `consent.{clientId, scopes (space-delimited), state, codeChallenge, loginHint?}`, `pickupHash` (`base64(sha256(pickup_secret))`), `botPublicKey` (`base64` X25519 public key). Response: `{ sessionId, authorizeUrl }`.
  - `POST /result` request: `{ sessionId, pickup_secret }`. Responses: `200 { sealedCode }` or `200 { error }`; `204` pending; `403` bad secret; `404` unknown/expired.
- The X25519 seal format spec: standard base64 (`base64_variants.ORIGINAL`); `botPublicKey` = raw 32-byte X25519 public key; `sealedCode` = `crypto_box_seal` output (48-byte overhead + plaintext). Bot opens with `crypto_box_seal_open(from_base64(sealedCode), botPub, botPriv)`.
- A note that the bot derives `pickupHash` as base64 of the SHA-256 digest of `pickup_secret` (matching `sha256Base64`).
- How to register the redirect URI: in Google Cloud Console, create an OAuth 2.0 "Web application" client and add `${BASE_URL}/callback` as an Authorized redirect URI.
- Local dev instructions: `cp .env.example .env`, set `KV_BACKEND=memory`, `npm install`, `npm run dev`, `npm test`.

Use this skeleton and fill each section with the content above:
```markdown
# marge-token-relay

<purpose + security model>

## Flow
<5 steps>

## API
### POST /session
<field table + example>
### GET /authorize?session=<id>
<302 to Google; 410 expired>
### GET /callback?state&code|error
<seals code, renders result page>
### POST /result
<field table + status codes>
### GET /healthz

## Seal format (X25519)
<base64 ORIGINAL, byte lengths, crypto_box_seal_open example>

## Registering the redirect URI with Google
<console steps; ${BASE_URL}/callback>

## Local development
<env + npm commands>

## Deploy (Render)
<render.yaml describes a web service + Render Key Value; set BASE_URL>
```

- [ ] **Step 5: Verify build + full suite + lint**

Run: `npm ci && npm run build && npm run lint && npm test`
Expected: build emits `dist/`, lint clean, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: Render deploy config, CircleCI pipeline, README bot contract"
```

---

## Notes for the implementer

- **ESM + `.js` import specifiers:** `tsconfig` uses `NodeNext`, so relative imports in `.ts` files must use the `.js` extension (e.g. `import { x } from './lib/kv.js'`). This is correct, not a typo.
- **`package-lock.json`:** generated by the first `npm install`; commit it (CI uses `npm ci`).
- **Static files in `dist/`:** `tsc` does not copy `src/public/*.html`. The `build` step must also place HTML where the compiled `dist/api/*.js` expects it (`dist/public`). Add a copy to the `build` script when wiring Task 11, e.g. `"build": "tsc -p tsconfig.json && cp -r src/public dist/public"`. (Tests run from `src/` via tsx, so they already find `src/public`.)
