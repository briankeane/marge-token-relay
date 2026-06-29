# marge-token-relay

`marge-token-relay` is a small Express/TypeScript service that relays a Google OAuth 2.0 authorization code from the browser to an off-network bot. It never holds a token, client secret, or plaintext code beyond the instant it seals and stores it: the relay receives the authorization code from Google, immediately seals it with the bot's X25519 public key using `crypto_box_seal`, stores only the sealed ciphertext in Redis under a short-lived session, and deletes it the moment the bot picks it up. The bot is the only party that can open the sealed code. The pickup endpoint is protected by a single-use, hashed secret so that only the bot that created the session can retrieve the result.

## Flow

1. **Bot calls `POST /session`** with its OAuth consent parameters, a hashed pickup secret (`pickupHash`), and its X25519 public key (`botPublicKey`). The relay creates a session and responds with a `sessionId` and an `authorizeUrl`.
2. **Bot sends `authorizeUrl` to the user** (e.g., in a chat message). The URL points to `GET /authorize?session=<sessionId>` on this relay.
3. **User opens `GET /authorize`** in a browser. The relay looks up the session and redirects (302) to Google's OAuth consent screen.
4. **Google redirects to `GET /callback`** with `?state=…&code=…` (or `?state=…&error=…`). The relay seals the authorization code with the bot's public key, stores the sealed ciphertext in the session record, and renders a result page to the user.
5. **Bot polls `POST /result`** with `sessionId` and `pickup_secret` until it receives a `200` response. On success, the response contains `sealedCode` (or `error` if Google returned an error). The session is deleted immediately after the `200` response (single-use).

## API

### POST /session

Creates a new relay session. Returns a `sessionId` and the `authorizeUrl` to send to the user.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `consent.clientId` | string | yes | Google OAuth 2.0 client ID |
| `consent.scopes` | string | yes | Space-delimited OAuth scopes |
| `consent.state` | string | yes | CSRF/PKCE state value (bot-generated, opaque) |
| `consent.codeChallenge` | string | yes | PKCE code challenge |
| `consent.loginHint` | string | no | Optional Google login hint (email) |
| `pickupHash` | string | yes | `base64(sha256(pickup_secret))` — standard base64, no padding stripping |
| `botPublicKey` | string | yes | Raw 32-byte X25519 public key encoded as standard base64 |

**Response — 201 Created:**

```json
{
  "sessionId": "xxxxxxxxxxxxxxxx",
  "authorizeUrl": "https://marge-token-relay.onrender.com/authorize?session=xxxxxxxxxxxxxxxx"
}
```

**Example request:**

```json
{
  "consent": {
    "clientId": "1234567890-abc.apps.googleusercontent.com",
    "scopes": "openid email profile",
    "state": "random-csrf-state",
    "codeChallenge": "S256-challenge-value",
    "loginHint": "user@example.com"
  },
  "pickupHash": "base64-encoded-sha256-of-pickup-secret",
  "botPublicKey": "base64-encoded-32-byte-x25519-public-key"
}
```

### GET /authorize?session=\<id\>

Looks up the session and issues a **302 redirect** to Google's OAuth consent screen with all stored consent parameters. The `redirect_uri` is set to `${BASE_URL}/callback`.

- **302** — redirect to Google consent screen
- **410** — session expired or not found; renders `expired.html`
- **400** — missing or malformed `session` query parameter

### GET /callback?state=…&code=…|error=…

Google redirects here after the user grants or denies consent. The relay:

1. Looks up the session via the `state` parameter.
2. If `code` is present: seals the code with the bot's public key and stores the `sealedCode` in the session record.
3. If `error` is present: stores the error string in the session record.
4. Renders `success.html` (code received) or `error.html` (error or session not found) to the user's browser.

The session status is set to `complete` so the bot's next poll returns `200`.

- **200** — result page rendered to user
- **410** — session not found (expired before Google redirected); renders `error.html`
- **400** — missing `state` parameter

### POST /result

Bot polls this endpoint to retrieve the sealed authorization code.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | yes | Session ID returned by `POST /session` |
| `pickup_secret` | string | yes | The raw pickup secret (pre-image of `pickupHash`) |

**Response status matrix:**

| Status | Body | Meaning |
|---|---|---|
| `200` | `{ "sealedCode": "<base64>" }` | OAuth code received and sealed; session deleted (single-use) |
| `200` | `{ "error": "<string>" }` | Google returned an OAuth error; session deleted |
| `204` | _(empty)_ | Session exists but code not yet received — poll again |
| `403` | `{ "error": "forbidden" }` | `pickup_secret` does not match `pickupHash` |
| `404` | `{ "error": "not_found" }` | Session not found (never existed or already consumed/expired) |
| `400` | `{ "error": "invalid_request" }` | Missing or non-string fields |

### GET /healthz

Returns `200 OK` with body `ok`. Used by Render as a health-check probe.

## Seal format (X25519)

The relay seals the authorization code using libsodium's `crypto_box_seal` with the bot's X25519 public key. All base64 encoding/decoding uses **`base64_variants.ORIGINAL`** (standard base64 with `+`, `/`, and `=` padding — not URL-safe).

- **`botPublicKey`**: a raw 32-byte X25519 public key, standard base64-encoded (44 characters with padding).
- **`sealedCode`**: the output of `crypto_box_seal(plaintext, botPubKey)`. libsodium adds a 48-byte ephemeral overhead (32-byte ephemeral public key + 16-byte MAC), so `sealedCode` is `48 + len(code)` bytes before base64 encoding.

**Bot-side decryption (Node.js + libsodium-wrappers):**

```js
import sodium from 'libsodium-wrappers';
await sodium.ready;

const sealedBytes = sodium.from_base64(sealedCode, sodium.base64_variants.ORIGINAL);
const plaintext = sodium.crypto_box_seal_open(sealedBytes, botPublicKey, botPrivateKey);
const code = sodium.to_string(plaintext);
```

**Deriving `pickupHash`:**

```js
import { createHash } from 'node:crypto';
const pickupHash = createHash('sha256').update(pickupSecret, 'utf8').digest('base64');
```

This matches the relay's `sha256Base64` function. The hash uses standard base64 with padding — do not strip `=`.

## Registering the redirect URI with Google

1. Open [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services** → **Credentials**.
2. Create or select an **OAuth 2.0 Client ID** of type **Web application**.
3. Under **Authorized redirect URIs**, add: `${BASE_URL}/callback` (e.g., `https://marge-token-relay.onrender.com/callback`).
4. Copy the **Client ID** — this is the `consent.clientId` field in `POST /session`. The **Client Secret** is NOT used by this relay; it stays in the bot.

## Local development

```bash
cp .env.example .env
# Edit .env: set KV_BACKEND=memory (no Redis needed for local dev)
npm install
npm run dev      # tsx watch — auto-reloads on file changes
npm test         # runs all 31 tests against in-memory KV
```

The `KV_BACKEND=memory` backend stores sessions in a plain JavaScript `Map` and requires no Redis instance. Tests always use the memory backend.

## Deploy (Render)

`render.yaml` in the repo root declares a **web service** (`marge-token-relay`) and a **Render Key Value** instance (`marge-token-relay-kv`). The `REDIS_URL` env var is wired automatically from the key-value service's connection string.

**Steps:**

1. Push this repo to GitHub.
2. In the [Render dashboard](https://render.com/), create a new **Blueprint** and point it at the repo — Render reads `render.yaml` automatically.
3. Set the `BASE_URL` environment variable to the web service's public URL (e.g., `https://marge-token-relay.onrender.com`). This is the only `sync: false` variable, so Render will prompt for it on first deploy.
4. Deploy. The build command (`npm ci && npm run build`) compiles TypeScript and copies static HTML to `dist/public/`; the start command runs `node dist/server.js`.
