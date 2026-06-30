# Relay local end-to-end proof (marge-bot as sole consumer)

**Date:** 2026-06-29
**Status:** Approved design — ready for implementation plan
**Scope:** "Approach 1" — prove the token relay works end-to-end locally against real Google, with marge-bot's role faithfully stood in. No production deploy, no changes to `marge-bot` or `account-hub-mcp`.

## Goal

The relay has solid per-endpoint tests, but **every test mocks Google and seals/opens with the same Node libsodium**. Two things have never been exercised:

1. **Real Google** — a real consent screen, a real authorization `code`, a real token redemption.
2. **Cross-library crypto** — the relay seals with Node `libsodium-wrappers`; the real consumer (marge-bot) opens with Python `PyNaCl`. Their interop (and base64-variant agreement) is untested.

This work closes both gaps and produces the reference implementation for marge-bot's future relay client.

**Success criterion:** one command + one browser consent prints a real, non-empty `access_token` and `refresh_token` for the consenting Google account. That — and only that — establishes the relay is deploy-ready.

## Architecture decisions (resolved)

- **Single consumer: marge-bot.** The design assumes marge-bot is the only party that interfaces with the relay. account-hub-mcp is out of scope.
- **marge-bot is the source of truth.** The moment it opens the sealed code, redeems it at Google, and stores the tokens, it owns them. The relay's session is already deleted (single-use). The relay is pure transient transport.
- **The relay relays a sealed authorization *code*, not tokens (Decision A).** marge-bot does the Google token exchange itself, using its own `client_secret` + PKCE `code_verifier`. The relay never holds a secret or a readable code — its sealed-box zero-knowledge model stays intact. (Decision B — relay exchanges and relays tokens — was rejected: it would put a long-lived Google secret and live tokens on a public service, defeating the relay's reason to exist.)
- **The relay code does not change.** This work only adds tests/tooling.

## The marge-bot ↔ relay contract

This is the contract the Python script implements and that marge-bot will later implement for real. Per session, the bot:

1. **Generates:**
   - **X25519 keypair** (PyNaCl `PrivateKey.generate()`). `botPublicKey` = `standard_b64encode(bytes(priv.public_key))` — 32 raw bytes, **padded standard base64**. Must satisfy the relay's strict `base64_variants.ORIGINAL` decoder (rejects url-safe `-_`).
   - **PKCE:** `code_verifier` (random, unreserved chars, 43–128 long); `code_challenge` = `base64url(sha256(verifier))`, **no padding**.
   - **Pickup secret:** random string; `pickupHash` = `base64(sha256(utf8(secret)))`, **standard base64 with padding** (matches the relay's `createHash('sha256').digest('base64')`).
   - **`state`:** random opaque string (the relay rejects a reused `state` with 409).

2. **`POST /session`** with body:
   ```json
   {
     "consent": { "clientId": "...", "scopes": "...", "state": "...", "codeChallenge": "...", "loginHint": "..." },
     "pickupHash": "...",
     "botPublicKey": "..."
   }
   ```
   → `201 { "sessionId": "<43-char base64url>", "authorizeUrl": "<BASE_URL>/authorize?session=<sessionId>" }`.

3. **Delivers `authorizeUrl` to the user.** Script: prints it (and may `webbrowser.open` it). Real marge-bot: sends it over iMessage/Slack. User opens it → relay 302s to Google → user consents → Google redirects to `<BASE_URL>/callback` → relay seals the code into the session.

4. **Polls `POST /result`** with `{ "sessionId": "...", "pickup_secret": "..." }`:
   - `204` → not ready, keep polling.
   - `200 { "sealedCode": "<base64>" }` → got it.
   - `200 { "error": "<string>" }` → Google returned an OAuth error (e.g. `access_denied`).
   - `403` → pickup secret mismatch; `404` → session expired/consumed; `400` → malformed.

5. **Opens + redeems:**
   - `code` = `SealedBox(priv).decrypt(standard_b64decode(sealedCode))` (PyNaCl `SealedBox` == libsodium `crypto_box_seal`).
   - `POST https://oauth2.googleapis.com/token` (form-encoded): `client_id`, `client_secret`, `code`, `code_verifier`, `grant_type=authorization_code`, `redirect_uri=<BASE_URL>/callback` (must match the authorize request **exactly**).
   - → real `access_token` + `refresh_token`. **Loop proven.**

## Prerequisite — Google OAuth client (step 0)

Required to make the loop real rather than mocked. One **Google Cloud "Web application" OAuth client** (Web type, because the redirect target is a server endpoint and the token exchange needs a `client_secret`):

- **Authorized redirect URI:** `http://localhost:3000/callback` (Google permits `http://localhost`). Must equal `<BASE_URL>/callback` exactly.
- **Test user:** the consenting Google account added as a test user if the consent screen is in "testing" publishing status.
- **Scope to start:** `openid email profile` — no API enablement needed, proves the loop. Swap to `gmail.readonly` later to mirror marge-bot exactly.

`client_id` and `client_secret` are supplied to the script via env (see below); they are never sent to the relay.

## Local run configuration

Relay, run locally in one terminal:

```
BASE_URL=http://localhost:3000
KV_BACKEND=memory
PORT=3000
# GOOGLE_AUTH_ENDPOINT defaults to the real Google endpoint
```

Script reads (env or `.env` in `test/e2e/`):

```
RELAY_BASE_URL=http://localhost:3000   # MUST match the relay's BASE_URL
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
OAUTH_SCOPES=openid email profile      # optional, defaults to this
```

## Artifact 1 — `test/e2e/relay_smoke.py` (primary deliverable)

A standalone Python script that performs all five contract steps against a locally-running relay and a real Google client. Manual (requires a human browser consent), real Google, written in Python to (a) validate PyNaCl↔libsodium interop and (b) serve as the marge-bot reference.

**Behavior:**
- Loads config from env / `test/e2e/.env`.
- Executes steps 1–5 above; polls `/result` every ~2s up to a cap (~180s).
- On success prints `PASS` plus token **metadata** — presence, length, `expires_in`, granted `scope`, and a short masked prefix. **Does not print full token or code values by default** (consistent with the relay's "NEVER log the code"); a `--show` flag reveals them for debugging.
- On any failure (non-201 session, OAuth `error`, `403/404`, decrypt failure, non-200 token exchange) prints `FAIL` with the reason and exits non-zero.

**Supporting files:**
- `test/e2e/requirements.txt` — `pynacl`, `requests`.
- `test/e2e/README.md` — prerequisites (Google client, env vars, relay running with `KV_BACKEND=memory`), `python -m venv` + install, and the run command. Notes that `RELAY_BASE_URL` must equal the relay's `BASE_URL` and the Google client's redirect URI.
- `.gitignore` entry for `test/e2e/.env` and the venv.

This script is **not throwaway**: it is the copy-paste reference for marge-bot's Phase-2 relay-client module, and a re-runnable real-Google smoke test for before/after deploy.

## Artifact 2 — `test/loop.test.ts` (automated complement)

A supertest test that wires the full sequence together in-process (the existing tests each seed KV by hand and test one endpoint). Mocks nothing except Google itself (the callback receives a fake `code` exactly as Google would deliver it). Runs in CI.

**Steps:**
1. Node keypair (`sodium.crypto_box_keypair`); build a valid `POST /session` body (consent fields, `pickupHash`, `botPublicKey` as base64 ORIGINAL). Expect `201`; capture `sessionId` and the chosen `state`.
2. `GET /authorize?session=<sessionId>` → expect `302`; assert `Location` is the Google endpoint with the right `redirect_uri` (`.../callback`), `code_challenge`, `code_challenge_method=S256`, and `state`.
3. `GET /callback?state=<state>&code=fake-auth-code` → expect `200` (success page).
4. `POST /result {sessionId, pickup_secret}` → expect `200 { sealedCode }`.
5. `crypto_box_seal_open` the `sealedCode` with the Node private key → assert it equals `fake-auth-code`.
6. (Optional) error path: `GET /callback?state=...&error=access_denied` → `/result` returns `200 { error: "access_denied" }`.

Uses `KV_BACKEND=memory`. Registered with the existing `mocha` suite so it runs under `npm test` / CI.

## Out of scope (explicitly)

- Any change to `marge-bot` or `account-hub-mcp` (that's Phase 2+).
- The account-hub-mcp token-ingest path.
- Production deploy (Render) — that's the victory lap after this proof is green.
- Headless/automated real-Google consent — the Python script is intentionally manual.
- Crypto/PKCE hardening beyond what the contract above requires.

## Follow-on phases (context, not part of this work)

1. **This work:** prove the loop locally.
2. Port `relay_smoke.py` into a marge-bot relay-client module (Python libsodium + PKCE + poll); replace marge-bot's loopback flow for the remote-user case.
3. Build a token-ingest path so marge-bot deposits tokens into account-hub-mcp (currently no programmatic ingest exists).
4. Deploy the relay to Render; register the production redirect URI; re-run `relay_smoke.py` against the live URL.
