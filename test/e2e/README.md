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
