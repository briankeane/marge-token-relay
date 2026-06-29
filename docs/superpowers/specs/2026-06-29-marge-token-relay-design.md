# marge-token-relay — Design

**Date:** 2026-06-29
**Status:** Approved

## Purpose

A tiny deployed web app that helps an off-network bot ("Marge", running
`account-hub-mcp` on a host with outbound-only internet) get a user through
Google OAuth. When a user's Google token expires, Marge texts the user a link to
this app; the user completes Google consent here; Marge polls this app until she
gets the result or times out, then finishes the token exchange herself.

## Core security model (do not weaken)

This app **never** holds a refresh token, an access token, or the OAuth client
secret. It only ever holds a short-lived Google authorization `code`, and it
stores even that **encrypted** to the bot's per-request public key (libsodium
sealed box / X25519). The bot performs the `code → token` exchange itself (it
holds the client secret and the PKCE verifier).

A full compromise of this app therefore yields only: ciphertext of a single-use,
PKCE-bound authorization code that has already expired or been consumed. PKCE
means a leaked code can't be exchanged by anyone but the bot anyway; the
encryption + pickup secret are defense-in-depth.

- **This app does NOT hold** the client secret, refresh tokens, or access tokens.
- **This app DOES hold** (transiently, TTL ~10 min, single-use): non-secret
  consent params, the bot's X25519 **public** key, `sha256(pickup_secret)`, and
  (after callback) the sealed authorization code.

## Scope decisions

| Decision | Choice | Rationale |
|---|---|---|
| Deploy target | **Render only** | Netlify Functions dropped. A long-running server removes the dual core+adapter architecture and the need for two KV impls. |
| Server | **Express 5 + TypeScript** | Plain Express; no serverless wrapper. |
| View layer | **Static HTML files** | Result pages are vanilla HTML with no interpolation; routes pick which file to send. |
| Storage | **Render Key Value (Redis)** | TTL and single-use (`GETDEL`) are native; no schema, migrations, or cleanup job. In-memory adapter used in tests. |
| Crypto binding | **libsodium-wrappers** | Pure-WASM, vetted, no native build, has `crypto_box_seal`. |
| Test framework | **Mocha + Chai + Supertest** | Matches reference repo backend conventions. |
| Rate limiting | **express-rate-limit (in-memory)** | Single Render instance; no Redis round-trips needed. |
| CI | **CircleCI** | Matches reference repo's primary pipeline. |

### Out of scope

No token exchange, no Google API calls, no token storage, no SMS, no user
accounts, no DB, no UI beyond the redirect + the static result pages.

## Conventions

Borrowed from `briankeane/node-react-scaffold` backend (`server/src/`), stripped
of the pieces we don't use (no `db/`, `queue/`, `docs/`, no `client/`). The
backend lives at the repo root `src/` (no `server/` wrapper, since there is no
client). Endpoints directory is named `api/` to match the scaffold.

## Project structure

```
marge-token-relay/
├── src/
│   ├── server.ts            # bootstrap + listen
│   ├── app.ts               # builds the Express app (testable, no listen); KV injected
│   ├── config.ts            # env parsing (BASE_URL, REDIS_URL, Google authorize endpoint, TTL)
│   ├── api/
│   │   ├── session.ts       # POST /session
│   │   ├── authorize.ts     # GET  /authorize
│   │   ├── callback.ts      # GET  /callback
│   │   ├── result.ts        # POST /result
│   │   └── health.ts        # GET  /healthz
│   ├── lib/
│   │   ├── kv.ts            # { put, get, getAndDelete } interface + Redis & in-memory impls
│   │   ├── crypto.ts        # sealed-box wrapper over libsodium-wrappers
│   │   ├── google.ts        # builds the Google consent URL from stored consent params
│   │   └── ids.ts          # long random sessionId generation / validation helpers
│   ├── middleware/
│   │   └── error.ts         # error handler; logs sessionId prefix + outcome only
│   └── public/
│       ├── success.html     # "You're all set — return to your conversation"
│       ├── error.html       # consent error / generic failure
│       └── expired.html     # served on 410 from /authorize
├── test/                    # mocha specs, mirrors src/
├── .circleci/config.yml
├── render.yaml
├── .env.example
├── README.md
└── package.json / tsconfig.json / .eslintrc / .prettierrc
```

## Storage schema

Two key namespaces in Render Key Value, both TTL ~600s:

- `session:<sessionId>` → JSON
  `{ consent, pickupHash, botPublicKey, status, sealedCode?, error?, createdAt }`
- `state:<state>` → `sessionId` (lookup used by `/callback` to find the session
  from Google's `state` param)

KV adapter interface: `{ put(key, val, ttl), get(key), getAndDelete(key) }`.
Two implementations: Redis (prod) and in-memory (tests/local).

## Endpoints & flow

1. **`POST /session`**
   Body: `{ consent: { clientId, scopes, state, codeChallenge, loginHint },
   pickupHash: sha256(pickup_secret), botPublicKey: base64(x25519 pub) }`.
   Validate, generate 32-byte random `sessionId`, store `session:<id>` and
   `state:<state>` with TTL, `status: "pending"`. Return
   `{ sessionId, authorizeUrl: "<BASE_URL>/authorize?session=<id>" }`.

2. **`GET /authorize?session=<id>`**
   Load `session:<id>`; if missing/expired → **410** + `expired.html`. Else build
   the Google consent URL from stored consent params +
   `redirect_uri=<BASE_URL>/callback`, `code_challenge_method=S256`,
   `access_type=offline`, `prompt=consent`, and **302** redirect. No secret is
   ever added.

3. **`GET /callback?state&code|error`**
   Load `sessionId` via `state:<state>`, then the session. Seal `code` to
   `botPublicKey` (`crypto_box_seal`) **or** capture `error`. Update session to
   `status: "complete"` with `{ sealedCode | error }`. Delete the `state:<state>`
   key (spent). Render `success.html` / `error.html`. **Never logs the code.**

4. **`POST /result { sessionId, pickup_secret }`**
   Load session; constant-time compare `sha256(pickup_secret)` to stored
   `pickupHash`. Outcomes:
   - match + `complete` → `getAndDelete(session:<id>)`, return
     `{ sealedCode | error }` **once** (single-use).
   - still pending → **204**.
   - bad secret → **403**.
   - unknown/expired → **404**.

5. **`GET /healthz`** → 200.

## Crypto seal format (bot contract)

`lib/crypto.ts` wraps `libsodium-wrappers`:

- `seal(plaintext: string, recipientPubKeyB64: string): string`
  → `base64(crypto_box_seal(utf8(code), pubkey))`.
- Constant-time compare helper for the pickup secret hash.

Wire format: `botPublicKey` and `sealedCode` are **standard base64** of raw bytes
(32-byte X25519 public key; sealed-box ciphertext = 48-byte overhead + plaintext).
Bot side (documented, not implemented here):
`crypto_box_seal_open(base64decode(sealedCode), botPub, botPriv)` → the `code`.

## Security & error handling

- `sessionId` and `state` are long random tokens (32 bytes), validated as
  well-formed before any KV lookup; malformed input rejected early.
- Constant-time compare (libsodium) for the pickup secret hash.
- `express-rate-limit` on `/session` and `/result`.
- Helmet for baseline security headers. HTTPS is platform-terminated by Render.
- Error middleware logs **only** the `sessionId` prefix (first 8 chars) +
  outcome — never the code, the pickup secret, or any full token.
- All KV entries TTL ~10 min and are single-use; no persistence beyond Redis.

## Testing (Mocha / Chai / Supertest)

Run against the Express app with the **in-memory KV** injected (no live Redis):

- **Happy path:** `session` → `authorize` (assert 302 + correct Google URL
  params) → `callback` (assert code sealed) → `result` (assert one-time sealed
  payload returned).
- **Expiry:** TTL elapsed → 410 (authorize) / 404 (result).
- **Single-use:** second `/result` for the same session → 404.
- **Bad secret:** wrong `pickup_secret` → 403.
- **Pending:** `/result` before callback → 204.
- **Crypto round-trip:** `seal` then `crypto_box_seal_open` with a test keypair
  recovers the original code.

## CI (CircleCI)

`.circleci/config.yml` — on every push/PR: checkout → Node setup → `npm ci` →
`npm run lint` → `npm test`. Lint and tests are both required checks. No deploy
step in CI (Render auto-deploys from the connected branch).

## Deploy

- `render.yaml`: one web service (`npm start`) + a Render Key Value instance,
  with env wired: `REDIS_URL`, `BASE_URL`, Google authorize endpoint, TTL.
- `.env.example`: documents every env var.
- `README.md`: documents the full 5-step bot contract, every field name, the
  X25519 seal format (encoding + byte lengths + exact libsodium calls), and how
  to register `<BASE_URL>/callback` as the authorized redirect URI on the Google
  "Web application" OAuth client.

## Config (env)

| Var | Purpose |
|---|---|
| `BASE_URL` | Public URL of this app; used to build `authorizeUrl` and `redirect_uri`. |
| `REDIS_URL` | Render Key Value connection string. |
| `KV_BACKEND` | `redis` (default) or `memory` (local/tests). |
| `GOOGLE_AUTH_ENDPOINT` | Google consent endpoint (overridable for tests). |
| `SESSION_TTL_SECONDS` | Entry TTL, default 600. |
| `PORT` | Server port (Render-provided). |
