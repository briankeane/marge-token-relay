# marge-web

`marge-web` is a small Express/TypeScript service that relays an OAuth 2.0 authorization code from the browser to an off-network bot. It supports multiple OAuth providers (Google and Spotify out of the box; the bot picks one per session via `consent.provider`). It never holds a token, client secret, or plaintext code beyond the instant it seals and stores it: the relay receives the authorization code from the provider, immediately seals it with the bot's X25519 public key using `crypto_box_seal`, stores only the sealed ciphertext in Redis under a short-lived session, and deletes it the moment the bot picks it up. The bot is the only party that can open the sealed code. The pickup endpoint is protected by a single-use, hashed secret so that only the bot that created the session can retrieve the result.

## Flow

1. **Bot calls `POST /session`** with its OAuth consent parameters, a hashed pickup secret (`pickupHash`), and its X25519 public key (`botPublicKey`). The relay creates a session and responds with a `sessionId` and an `authorizeUrl`.
2. **Bot sends `authorizeUrl` to the user** (e.g., in a chat message). The URL points to `GET /authorize?session=<sessionId>` on this relay.
3. **User opens `GET /authorize`** in a browser. The relay looks up the session and redirects (302) to the selected provider's OAuth consent screen.
4. **The provider redirects to `GET /callback`** with `?state=…&code=…` (or `?state=…&error=…`). The relay seals the authorization code with the bot's public key, stores the sealed ciphertext in the session record, and renders a result page to the user.
5. **Bot polls `POST /result`** with `sessionId` and `pickup_secret` until it receives a `200` response. On success, the response contains `sealedCode` (or `error` if the provider returned an error). The session is deleted immediately after the `200` response (single-use).

## API

### POST /session

Creates a new relay session. Returns a `sessionId` and the `authorizeUrl` to send to the user.

**Request body:**

| Field                   | Type   | Required | Description                                                                              |
| ----------------------- | ------ | -------- | ---------------------------------------------------------------------------------------- |
| `consent.provider`      | string | no       | OAuth provider: `google` (default) or `spotify`. Unknown values are rejected with `400`. |
| `consent.clientId`      | string | yes      | The provider's OAuth 2.0 client ID                                                       |
| `consent.scopes`        | string | yes      | Space-delimited OAuth scopes                                                             |
| `consent.state`         | string | yes      | CSRF/PKCE state value (bot-generated, opaque)                                            |
| `consent.codeChallenge` | string | yes      | PKCE code challenge                                                                      |
| `consent.loginHint`     | string | no       | Optional login hint (email); forwarded only for providers that support it (Google)       |
| `pickupHash`            | string | yes      | `base64(sha256(pickup_secret))` — standard base64, no padding stripping                  |
| `botPublicKey`          | string | yes      | Raw 32-byte X25519 public key encoded as standard base64                                 |

**Response — 201 Created:**

```json
{
  "sessionId": "xxxxxxxxxxxxxxxx",
  "authorizeUrl": "https://api.marge.playola.fm/authorize?session=xxxxxxxxxxxxxxxx"
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

Looks up the session and issues a **302 redirect** to the session provider's OAuth consent screen with all stored consent parameters. The `redirect_uri` is set to `${BASE_URL}/callback`.

- **302** — redirect to the provider's consent screen
- **410** — session expired or not found; renders `expired.html`
- **400** — missing or malformed `session` query parameter

### GET /callback?state=…&code=…|error=…

The provider redirects here after the user grants or denies consent. The relay:

1. Looks up the session via the `state` parameter.
2. If `code` is present: seals the code with the bot's public key and stores the `sealedCode` in the session record.
3. If `error` is present: stores the error string in the session record.
4. Renders `success.html` (code received) or `error.html` (error or session not found) to the user's browser.

The session status is set to `complete` so the bot's next poll returns `200`.

- **200** — result page rendered to user
- **410** — session not found (expired before the provider redirected); renders `error.html`
- **400** — missing `state` parameter

### POST /result

Bot polls this endpoint to retrieve the sealed authorization code.

**Request body:**

| Field           | Type   | Required | Description                                       |
| --------------- | ------ | -------- | ------------------------------------------------- |
| `sessionId`     | string | yes      | Session ID returned by `POST /session`            |
| `pickup_secret` | string | yes      | The raw pickup secret (pre-image of `pickupHash`) |

**Response status matrix:**

| Status | Body                             | Meaning                                                       |
| ------ | -------------------------------- | ------------------------------------------------------------- |
| `200`  | `{ "sealedCode": "<base64>" }`   | OAuth code received and sealed; session deleted (single-use)  |
| `200`  | `{ "error": "<string>" }`        | The provider returned an OAuth error; session deleted         |
| `204`  | _(empty)_                        | Session exists but code not yet received — poll again         |
| `403`  | `{ "error": "forbidden" }`       | `pickup_secret` does not match `pickupHash`                   |
| `404`  | `{ "error": "not_found" }`       | Session not found (never existed or already consumed/expired) |
| `400`  | `{ "error": "invalid_request" }` | Missing or non-string fields                                  |

### GET /healthz

Returns `200` with JSON body `{"status":"ok"}`. Used by Render as a health-check probe.

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

## Registering the redirect URI

Every provider must be told to accept the relay's single callback URL, `${BASE_URL}/callback`. The value must match **byte-for-byte** (scheme, host, path, no trailing slash). The **Client Secret** is never used by this relay — it stays in the bot, which performs the code→token exchange. The same `/callback` serves all providers; the relay tells sessions apart by `state`, not by path.

### Google

1. Open [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services** → **Credentials**.
2. Create or select an **OAuth 2.0 Client ID** of type **Web application**.
3. Under **Authorized redirect URIs**, add: `${BASE_URL}/callback` (e.g., `https://auth.marge-bot.com/callback`).
4. Copy the **Client ID** — this is the `consent.clientId` field in `POST /session` (with `consent.provider` omitted or set to `google`).

### Spotify

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) → **Create app**.
2. Under **Redirect URIs**, add: `${BASE_URL}/callback` (e.g., `https://auth.marge-bot.com/callback`). Spotify requires **HTTPS** (as of the 27 Nov 2025 OAuth migration); `localhost` is rejected, only loopback IPs may use HTTP.
3. Copy the **Client ID** — pass it as `consent.clientId` with `consent.provider: "spotify"` in `POST /session`.
4. The app can stay in **Development Mode** for a small number of users (up to 25). Each user must be added to the app's user allowlist in the dashboard, or their consent will fail.

## Local development

The backend relay now lives in `server/`. Run it directly:

```bash
cd server
cp .env.example .env
# Edit .env: set KV_BACKEND=memory (no Redis needed for local dev)
npm install
npm run dev      # tsx watch — auto-reloads on file changes
npm test         # runs the full test suite against an in-memory KV
```

The `KV_BACKEND=memory` backend stores sessions in a plain JavaScript `Map` and requires no Redis instance. Tests always use the memory backend.

Alternatively, bring up the full stack (Postgres + relay + client) with Docker:

```bash
make install     # installs server/ and client/ deps
make launch      # docker compose up (postgres, migrate, server on :3000, client on :5173)
```

## Deploy (Render, image-based)

The backend deploys as a Docker image. `render.yaml` declares a web service (`marge-api`, `runtime: image`, pulling `ghcr.io/playola-radio/marge-web:production`), a Postgres database (`marge-api-db`) and a Render Key Value instance (`marge-api-kv`). `DATABASE_URL` and `REDIS_URL` are wired from those automatically; `preDeployCommand` runs `npm run migrate`, and Render probes `/v1/healthCheck`.

**How deploys happen:** pushing to `main` (or running the workflow manually via **Run workflow** / `workflow_dispatch`) triggers `.github/workflows/deploy-production.yml`. After the server checks pass, it builds `server/Dockerfile.production`, pushes `:production` and `:<git-sha>` to GHCR, then calls the Render deploy API. That final deploy call is **skipped** whenever the `RENDER_PRODUCTION_SERVICE_ID` secret is unset, so a run before the service exists just builds and pushes the image. `autoDeployTrigger` is `off`, so an image push alone does not deploy.

**MANUAL / OWNER-GATED cutover steps** (NOT done by this repo or CI automatically), in order:

1. **Seed the image.** Run the `deploy-production` workflow once (merge/push to `main`, or **Run workflow** on the Actions tab). It builds and pushes `ghcr.io/playola-radio/marge-web:production`; the Render deploy call is skipped on this run because `RENDER_PRODUCTION_SERVICE_ID` isn't set yet, so the run is green.
2. **Authorize Render to pull the image.** GHCR packages are PRIVATE by default. EITHER make the `ghcr.io/playola-radio/marge-web` package public, OR add a Render registry credential (GHCR username + a PAT with `read:packages`) and reference it via `fromRegistryCreds` on the image service in `render.yaml`.
3. **Do the first Blueprint apply in Render.** Now that the image exists and is pullable, this succeeds and creates the service `marge-api`, the database `marge-api-db`, the key-value `marge-api-kv`, and the `production` env group (declared in `render.yaml`; you do not create the group by hand).
4. **Set the VALUE of `JWT_SECRET`** in the `production` env group. It is declared `sync: false`, so Render leaves it blank for you to fill in; until set, protected `/v1` routes safely return 401.
5. **Set GitHub repo secrets** `RENDER_API_KEY` and `RENDER_PRODUCTION_SERVICE_ID` (the service ID now exists, from step 3). From here on, pushes to `main` build, push, and auto-deploy.
6. **Update the Google and Spotify OAuth redirect URIs** to `https://api.marge.playola.fm/callback`, byte-for-byte. This must match `BASE_URL` in `render.yaml`.

**Frontend:** deployed separately to Netlify (site `marge-web`, `marge.playola.fm`) via `netlify.toml`.
