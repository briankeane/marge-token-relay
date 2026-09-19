# Relay end-to-end check (`relay_smoke.py`)

Stands in for **marge-bot**: generates an X25519 keypair + PKCE + pickup secret,
creates a relay session, retrieves the sealed authorization code, and (in `real`
mode) redeems it at Google for tokens. Also the reference implementation for
marge-bot's future relay client.

## Setup (once)

```bash
python3 -m venv test/e2e/.venv
test/e2e/.venv/bin/pip install -r test/e2e/requirements.txt
```

## Run the relay locally (separate terminal)

```bash
BASE_URL=http://localhost:3000 KV_BACKEND=memory PORT=3000 npm run dev
```

## `interop` mode — automated, no Google, no browser

Proves Python (PyNaCl) opens what the relay (Node libsodium) sealed:

```bash
test/e2e/.venv/bin/python test/e2e/relay_smoke.py interop
```

Expected: `PASS interop: ...`.

## `real` mode — real browser consent + Google token exchange

Requires a Google OAuth client (see below) and these env vars (export them or
put them in `test/e2e/.env`):

```
RELAY_BASE_URL=http://localhost:3000   # MUST match the relay's BASE_URL
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
OAUTH_SCOPES=openid email profile      # optional
```

```bash
test/e2e/.venv/bin/python test/e2e/relay_smoke.py real          # masks tokens
test/e2e/.venv/bin/python test/e2e/relay_smoke.py real --show   # prints tokens
```

Expected: `PASS real: ...` with a non-empty access + refresh token.

### Google OAuth client (step 0 for `real` mode)

In Google Cloud Console, create an **OAuth client of type "Web application"**:

- Authorized redirect URI: `http://localhost:3000/callback` (must equal `<BASE_URL>/callback`).
- If the consent screen is in "testing" status, add your Google account as a **test user**.
- Start with scope `openid email profile` (no API enablement needed).

Put its client ID/secret in `test/e2e/.env`.

## `spotify` mode — real browser consent + Spotify token exchange

Same shape as `real`, but sends `provider: "spotify"` and redeems the code at
Spotify's token endpoint. Env vars (in `test/e2e/.env` or exported):

```
RELAY_BASE_URL=https://auth.marge-bot.com   # or http://127.0.0.1:3000 for a local relay
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_SCOPES=playlist-modify-public playlist-modify-private   # optional
```

```bash
test/e2e/.venv/bin/python test/e2e/relay_smoke.py spotify          # masks tokens
test/e2e/.venv/bin/python test/e2e/relay_smoke.py spotify --show   # prints tokens
```

Expected: `PASS spotify: ...` with a non-empty access + refresh token.

### Spotify app setup (step 0 for `spotify` mode)

In the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard),
create an app:

- **Redirect URI** must exactly equal `<RELAY_BASE_URL>/callback`. Spotify requires
  **HTTPS** — `https://auth.marge-bot.com/callback` for the deployed relay. `localhost`
  is banned; only a loopback IP may use HTTP, so for a **local** relay register
  `http://127.0.0.1:3000/callback` and run the relay with `BASE_URL=http://127.0.0.1:3000`.
- In Development Mode, add the consenting Spotify account to the app's **user list**.

Put the client ID/secret in `test/e2e/.env`.
