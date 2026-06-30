# Relay Local End-to-End Proof — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the token relay round-trips a real Google authorization code end-to-end locally, with marge-bot's role faithfully stood in, and add an automated full-sequence regression test.

**Architecture:** The relay code does **not** change. We add (1) a TypeScript supertest test that wires `session → authorize → callback → result` together in-process with a real Node-libsodium seal/open, and (2) a Python script that performs the same flow against a locally-running relay — an automated `interop` mode (no Google, proves PyNaCl↔libsodium interop) and a manual `real` mode (real browser consent + Google token exchange). The Python script doubles as the reference implementation for marge-bot's future relay client.

**Tech Stack:** Node 20 / TypeScript / mocha + chai + supertest / `libsodium-wrappers` (relay & TS test); Python 3 / PyNaCl / requests (e2e script).

## Global Constraints

- Relay source under `src/` is **not modified** by this plan — tests/tooling only.
- Node `>=20`; Python `>=3.9`.
- `botPublicKey` = **padded standard base64** of the 32-byte raw X25519 public key (must decode under libsodium `base64_variants.ORIGINAL`; url-safe `-_` is rejected).
- `pickupHash` = **padded standard base64** of `sha256(utf8(pickup_secret))` (matches the relay's `createHash('sha256').digest('base64')`).
- PKCE `code_challenge` = **unpadded url-safe base64** of `sha256(code_verifier)`, method `S256`.
- The token-exchange `redirect_uri` must equal `<BASE_URL>/callback` **exactly** (same string the relay used in `/authorize`).
- Local relay runs with `BASE_URL=http://localhost:3000`, `KV_BACKEND=memory`, `PORT=3000`.
- The Python script **never prints full code or token values by default** — masked metadata only; a `--show` flag reveals them.

---

### Task 1: Automated full-sequence supertest (`test/loop.test.ts`)

Wires the whole relay sequence together in one test (the existing tests each seed KV by hand and exercise one endpoint). Mocks nothing except Google itself — the callback receives a fake `code` exactly as Google would deliver it. This test characterizes already-working behavior, so it should **pass on first run**; a failure is a real relay regression to investigate, not an expected red.

**Files:**
- Create: `test/loop.test.ts`

**Interfaces:**
- Consumes: `buildApp` from `src/app.js`, `loadConfig` from `src/config.js`, `MemoryKV` from `src/lib/kv.js`, `initCrypto` from `src/lib/crypto.js`, `libsodium-wrappers` via `createRequire`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the test**

Create `test/loop.test.ts`:

```ts
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { expect } from 'chai';
import request from 'supertest';
import { buildApp } from '../src/app.js';

// libsodium-wrappers ESM build is broken (missing libsodium.mjs sibling);
// force the CJS path via createRequire, same as crypto.ts and the other tests.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sodium = require('libsodium-wrappers') as typeof import('libsodium-wrappers');

import { loadConfig } from '../src/config.js';
import { MemoryKV } from '../src/lib/kv.js';
import { initCrypto } from '../src/lib/crypto.js';

describe('full relay loop (session -> authorize -> callback -> result)', () => {
  let keypair: sodium.KeyPair;

  before(async () => {
    await initCrypto();
    keypair = sodium.crypto_box_keypair();
  });

  function makeApp() {
    const config = loadConfig({
      BASE_URL: 'https://relay.test',
      KV_BACKEND: 'memory',
    } as NodeJS.ProcessEnv);
    return buildApp({ kv: new MemoryKV(), config });
  }

  function botPublicKey(): string {
    return sodium.to_base64(keypair.publicKey, sodium.base64_variants.ORIGINAL);
  }

  it('relays a real sealed code end to end and the bot key opens it', async () => {
    const app = makeApp();
    const pickupSecret = 'pickup-secret-value';
    const pickupHash = createHash('sha256').update(pickupSecret, 'utf8').digest('base64');
    const state = 'loop-state-1';

    // 1. POST /session
    const sessionRes = await request(app).post('/session').send({
      consent: {
        clientId: 'client-loop',
        scopes: 'openid email profile',
        state,
        codeChallenge: 'challenge-loop',
      },
      pickupHash,
      botPublicKey: botPublicKey(),
    });
    expect(sessionRes.status).to.equal(201);
    const { sessionId } = sessionRes.body;
    expect(sessionId).to.match(/^[A-Za-z0-9_-]{43}$/);

    // 2. GET /authorize -> 302 to Google with the right params
    const authRes = await request(app).get(`/authorize?session=${sessionId}`);
    expect(authRes.status).to.equal(302);
    const location = new URL(authRes.headers.location);
    expect(location.origin + location.pathname).to.equal(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(location.searchParams.get('redirect_uri')).to.equal('https://relay.test/callback');
    expect(location.searchParams.get('code_challenge')).to.equal('challenge-loop');
    expect(location.searchParams.get('code_challenge_method')).to.equal('S256');
    expect(location.searchParams.get('state')).to.equal(state);
    expect(location.searchParams.get('client_id')).to.equal('client-loop');

    // 3. GET /callback (Google delivers a fake code) -> 200 success page
    const cbRes = await request(app).get(`/callback?state=${state}&code=fake-auth-code`);
    expect(cbRes.status).to.equal(200);
    expect(cbRes.text).to.contain('all set');

    // 4. POST /result -> 200 with sealedCode
    const resultRes = await request(app)
      .post('/result')
      .send({ sessionId, pickup_secret: pickupSecret });
    expect(resultRes.status).to.equal(200);
    expect(resultRes.body.sealedCode).to.be.a('string');

    // 5. The bot's private key opens the sealed code
    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(resultRes.body.sealedCode, sodium.base64_variants.ORIGINAL),
      keypair.publicKey,
      keypair.privateKey,
    );
    expect(new TextDecoder().decode(opened)).to.equal('fake-auth-code');
  });

  it('relays a Google OAuth error to the bot', async () => {
    const app = makeApp();
    const pickupSecret = 'pickup-secret-2';
    const pickupHash = createHash('sha256').update(pickupSecret, 'utf8').digest('base64');
    const state = 'loop-state-2';

    const sessionRes = await request(app).post('/session').send({
      consent: { clientId: 'c', scopes: 'openid', state, codeChallenge: 'ch' },
      pickupHash,
      botPublicKey: botPublicKey(),
    });
    expect(sessionRes.status).to.equal(201);
    const { sessionId } = sessionRes.body;

    const cbRes = await request(app).get(`/callback?state=${state}&error=access_denied`);
    expect(cbRes.status).to.equal(200);

    const resultRes = await request(app)
      .post('/result')
      .send({ sessionId, pickup_secret: pickupSecret });
    expect(resultRes.status).to.equal(200);
    expect(resultRes.body.error).to.equal('access_denied');
    expect(resultRes.body.sealedCode).to.equal(undefined);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx mocha test/loop.test.ts`
Expected: `2 passing`. (If anything fails, stop — it is a genuine relay regression; investigate before continuing.)

- [ ] **Step 3: Run the full suite to confirm no interference**

Run: `npm test`
Expected: the whole suite passes, including the two new `full relay loop` tests.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add test/loop.test.ts
git commit -m "test: full session->authorize->callback->result loop test"
```

---

### Task 2: Python crypto/PKCE helpers + offline unit tests

The pure, offline-testable core of the e2e script: keypair, PKCE, pickup-hash, and sealed-box open. No relay, no Google — fully deterministic.

**Files:**
- Create: `test/e2e/relay_smoke.py` (helpers only in this task)
- Create: `test/e2e/test_relay_smoke.py`
- Create: `test/e2e/requirements.txt`
- Modify: `.gitignore`

**Interfaces:**
- Produces (used by Tasks 3 & 4):
  - `gen_keypair() -> (nacl.public.PrivateKey, str)` — returns `(private_key, bot_public_key_b64)`.
  - `pkce_challenge(verifier: str) -> str` — unpadded url-safe base64 of `sha256(verifier)`.
  - `make_pkce() -> (str, str)` — returns `(code_verifier, code_challenge)`.
  - `make_pickup() -> (str, str)` — returns `(pickup_secret, pickup_hash)`.
  - `open_sealed(priv: nacl.public.PrivateKey, sealed_b64: str) -> str` — opens a sealed code.

- [ ] **Step 1: Write requirements and the failing tests**

Create `test/e2e/requirements.txt`:

```
pynacl>=1.5
requests>=2.31
pytest>=8.0
```

Create `test/e2e/test_relay_smoke.py`:

```python
import base64
import hashlib

from relay_smoke import pkce_challenge, make_pkce, make_pickup, gen_keypair


def test_pkce_challenge_matches_rfc7636_vector():
    # RFC 7636 Appendix B known-answer vector.
    verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    assert pkce_challenge(verifier) == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"


def test_make_pkce_challenge_is_unpadded_urlsafe():
    _, challenge = make_pkce()
    assert "=" not in challenge
    assert "+" not in challenge
    assert "/" not in challenge


def test_pickup_hash_is_padded_standard_base64_of_sha256_utf8():
    secret, pickup_hash = make_pickup()
    assert base64.standard_b64decode(pickup_hash) == hashlib.sha256(secret.encode("utf-8")).digest()
    # sha256 digest is 32 bytes -> standard base64 is 44 chars ending in one '='.
    assert pickup_hash.endswith("=")


def test_bot_public_key_is_32_byte_padded_standard_base64():
    _, bot_pub = gen_keypair()
    raw = base64.standard_b64decode(bot_pub)
    assert len(raw) == 32
```

- [ ] **Step 2: Create the virtualenv and install deps**

```bash
python3 -m venv test/e2e/.venv
test/e2e/.venv/bin/pip install -r test/e2e/requirements.txt
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `test/e2e/.venv/bin/python -m pytest test/e2e/test_relay_smoke.py -v`
Expected: FAIL — `ImportError`/`ModuleNotFoundError: No module named 'relay_smoke'` (functions not yet written).

- [ ] **Step 4: Write the helpers**

Create `test/e2e/relay_smoke.py`:

```python
#!/usr/bin/env python3
"""Local end-to-end exercise of the marge-token-relay, standing in for marge-bot.

Two modes (see Tasks 3-4):
  interop  - no Google, no browser: proves PyNaCl opens what the relay's libsodium sealed.
  real     - real browser consent + real Google token exchange.
"""
import base64
import hashlib
import os
import secrets

from nacl.public import PrivateKey, SealedBox


def gen_keypair():
    """Return (private_key, bot_public_key_b64). Public key is padded standard base64."""
    priv = PrivateKey.generate()
    pub_raw = bytes(priv.public_key)
    return priv, base64.standard_b64encode(pub_raw).decode("ascii")


def pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def make_pkce():
    verifier = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode("ascii")
    return verifier, pkce_challenge(verifier)


def make_pickup():
    secret = secrets.token_urlsafe(32)
    digest = hashlib.sha256(secret.encode("utf-8")).digest()
    return secret, base64.standard_b64encode(digest).decode("ascii")


def open_sealed(priv: PrivateKey, sealed_b64: str) -> str:
    sealed = base64.standard_b64decode(sealed_b64)
    return SealedBox(priv).decrypt(sealed).decode("utf-8")
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `test/e2e/.venv/bin/python -m pytest test/e2e/test_relay_smoke.py -v`
Expected: `4 passed`.

- [ ] **Step 6: Ignore the venv and pycache**

Append to `.gitignore`:

```
test/e2e/.venv/
__pycache__/
*.pyc
```

(`.env` is already ignored at any depth by the existing `.env` rule.)

- [ ] **Step 7: Commit**

```bash
git add test/e2e/relay_smoke.py test/e2e/test_relay_smoke.py test/e2e/requirements.txt .gitignore
git commit -m "test(e2e): python relay-client crypto/pkce helpers + unit tests"
```

---

### Task 3: Relay flow + automated `interop` mode + README

Adds the relay HTTP calls and the no-Google `interop` mode: create a session, simulate Google's redirect by calling `/callback` directly with a known probe code, poll `/result`, open the sealed code, and assert it round-trips. This is the automated proof that Python PyNaCl opens what Node libsodium sealed.

**Files:**
- Modify: `test/e2e/relay_smoke.py`
- Create: `test/e2e/README.md`

**Interfaces:**
- Consumes: `gen_keypair`, `make_pkce`, `make_pickup`, `open_sealed` (Task 2).
- Produces (used by Task 4):
  - `create_session(base, client_id, scopes, state, code_challenge, pickup_hash, bot_pub_b64, login_hint=None) -> (str, str)` — returns `(session_id, authorize_url)`.
  - `poll_result(base, session_id, secret, timeout=180, interval=2) -> dict` — returns the `/result` JSON (`{"sealedCode": ...}` or `{"error": ...}`).
  - `load_env_file(path) -> None`, `run_interop(base) -> None`, `main() -> None`.

- [ ] **Step 1: Add the relay calls, interop mode, and entry point**

Edit `test/e2e/relay_smoke.py` — add these imports at the top (with the existing ones):

```python
import sys
import time

import requests
```

Append the following to `test/e2e/relay_smoke.py`:

```python
def load_env_file(path: str) -> None:
    """Minimal .env loader (KEY=VALUE per line) so the script has zero non-listed deps."""
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            os.environ.setdefault(key.strip(), val.strip())


def create_session(base, client_id, scopes, state, code_challenge, pickup_hash, bot_pub_b64,
                   login_hint=None):
    consent = {
        "clientId": client_id,
        "scopes": scopes,
        "state": state,
        "codeChallenge": code_challenge,
    }
    if login_hint:
        consent["loginHint"] = login_hint
    resp = requests.post(
        f"{base}/session",
        json={"consent": consent, "pickupHash": pickup_hash, "botPublicKey": bot_pub_b64},
        timeout=30,
    )
    if resp.status_code != 201:
        raise RuntimeError(f"POST /session -> {resp.status_code}: {resp.text}")
    body = resp.json()
    return body["sessionId"], body["authorizeUrl"]


def poll_result(base, session_id, secret, timeout=180, interval=2):
    deadline = time.time() + timeout
    while time.time() < deadline:
        resp = requests.post(
            f"{base}/result",
            json={"sessionId": session_id, "pickup_secret": secret},
            timeout=30,
        )
        if resp.status_code == 204:
            time.sleep(interval)
            continue
        if resp.status_code == 200:
            return resp.json()
        raise RuntimeError(f"POST /result -> {resp.status_code}: {resp.text}")
    raise TimeoutError("timed out waiting for /result")


def run_interop(base: str) -> None:
    """No Google, no browser: prove PyNaCl opens what the relay's libsodium sealed."""
    priv, bot_pub = gen_keypair()
    _verifier, challenge = make_pkce()
    secret, pickup_hash = make_pickup()
    state = secrets.token_urlsafe(16)
    probe = "interop-probe-" + secrets.token_hex(6)

    session_id, _authorize_url = create_session(
        base, "interop-client", "openid email", state, challenge, pickup_hash, bot_pub
    )
    # Simulate Google's redirect straight to the relay callback (server endpoint, no browser).
    cb = requests.get(f"{base}/callback", params={"state": state, "code": probe}, timeout=30)
    if cb.status_code != 200:
        raise RuntimeError(f"GET /callback -> {cb.status_code}: {cb.text}")

    result = poll_result(base, session_id, secret, timeout=30)
    if "sealedCode" not in result:
        raise RuntimeError(f"expected sealedCode, got {result}")
    opened = open_sealed(priv, result["sealedCode"])
    if opened != probe:
        raise AssertionError(f"interop mismatch: {opened!r} != {probe!r}")
    print(f"PASS interop: PyNaCl opened the libsodium-sealed code ({len(opened)} chars matched).")


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    load_env_file(os.path.join(here, ".env"))
    base = os.environ.get("RELAY_BASE_URL", "http://localhost:3000").rstrip("/")
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    mode = args[0] if args else "real"
    if mode == "interop":
        run_interop(base)
    else:
        print(f"unknown mode {mode!r}; expected 'interop' (real mode added in Task 4)")
        sys.exit(2)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Create the README**

Create `test/e2e/README.md`:

````markdown
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
````

- [ ] **Step 3: Run the interop check against a running relay**

In terminal A: `BASE_URL=http://localhost:3000 KV_BACKEND=memory PORT=3000 npm run dev`
In terminal B: `test/e2e/.venv/bin/python test/e2e/relay_smoke.py interop`
Expected: `PASS interop: PyNaCl opened the libsodium-sealed code (...).`

- [ ] **Step 4: Confirm the offline unit tests still pass**

Run: `test/e2e/.venv/bin/python -m pytest test/e2e/test_relay_smoke.py -v`
Expected: `4 passed` (helpers unchanged, imports still valid).

- [ ] **Step 5: Commit**

```bash
git add test/e2e/relay_smoke.py test/e2e/README.md
git commit -m "test(e2e): relay flow + automated interop mode + README"
```

---

### Task 4: Real-Google `real` mode (Approach 1 success criterion)

Adds the token exchange and the manual `real` mode: real browser consent, open the sealed code, redeem it at Google, print masked token metadata. Passing this is the deploy-readiness proof.

**Files:**
- Modify: `test/e2e/relay_smoke.py`

**Interfaces:**
- Consumes: all of Tasks 2 & 3.
- Produces: `require_env(name) -> str`, `mask(value) -> str`, `exchange_code(...) -> dict`, `run_real(base) -> None`; extends `main()` to dispatch `real`.

- [ ] **Step 1: Add token exchange and the `real` flow**

Edit `test/e2e/relay_smoke.py` — add this import with the others:

```python
import webbrowser
```

Append to `test/e2e/relay_smoke.py`:

```python
def require_env(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        print(f"FAIL: required env var {name} is not set (see test/e2e/README.md)")
        sys.exit(2)
    return val


def mask(value: str) -> str:
    if not value:
        return "<missing>"
    return f"{value[:6]}...({len(value)} chars)"


def exchange_code(code, client_id, client_secret, code_verifier, redirect_uri):
    resp = requests.post(
        "https://oauth2.googleapis.com/token",
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
            "code_verifier": code_verifier,
            "grant_type": "authorization_code",
            "redirect_uri": redirect_uri,
        },
        timeout=30,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Google token endpoint -> {resp.status_code}: {resp.text}")
    return resp.json()


def run_real(base: str, show: bool) -> None:
    client_id = require_env("GOOGLE_CLIENT_ID")
    client_secret = require_env("GOOGLE_CLIENT_SECRET")
    scopes = os.environ.get("OAUTH_SCOPES", "openid email profile")
    redirect_uri = f"{base}/callback"

    priv, bot_pub = gen_keypair()
    verifier, challenge = make_pkce()
    secret, pickup_hash = make_pickup()
    state = secrets.token_urlsafe(16)

    session_id, authorize_url = create_session(
        base, client_id, scopes, state, challenge, pickup_hash, bot_pub
    )
    print(f"\nOpen this URL in your browser and grant consent:\n\n  {authorize_url}\n")
    try:
        webbrowser.open(authorize_url)
    except Exception:
        pass

    print("Waiting for the sealed code (polling /result)...")
    result = poll_result(base, session_id, secret, timeout=180)
    if "error" in result:
        print(f"FAIL: Google returned an OAuth error: {result['error']}")
        sys.exit(1)

    code = open_sealed(priv, result["sealedCode"])
    print("Opened the sealed code; redeeming it at Google's token endpoint...")
    tokens = exchange_code(code, client_id, client_secret, verifier, redirect_uri)

    access = tokens.get("access_token")
    refresh = tokens.get("refresh_token")
    if not access or not refresh:
        print(f"FAIL: token response missing access/refresh token (keys={list(tokens)})")
        sys.exit(1)

    print("\nPASS real: the relay delivered a redeemable Google authorization code.")
    print(f"  access_token : {access if show else mask(access)}")
    print(f"  refresh_token: {refresh if show else mask(refresh)}")
    print(f"  expires_in   : {tokens.get('expires_in')}")
    print(f"  scope        : {tokens.get('scope')}")
```

- [ ] **Step 2: Wire `real` into `main()`**

In `test/e2e/relay_smoke.py`, replace the `main()` body from Task 3 with:

```python
def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    load_env_file(os.path.join(here, ".env"))
    base = os.environ.get("RELAY_BASE_URL", "http://localhost:3000").rstrip("/")
    show = "--show" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    mode = args[0] if args else "real"
    if mode == "interop":
        run_interop(base)
    elif mode == "real":
        run_real(base, show)
    else:
        print(f"usage: relay_smoke.py [interop|real] [--show]  (got mode {mode!r})")
        sys.exit(2)
```

- [ ] **Step 3: Verify the script still imports and unit tests pass**

Run: `test/e2e/.venv/bin/python -m pytest test/e2e/test_relay_smoke.py -v`
Expected: `4 passed` (no syntax/import errors introduced).

- [ ] **Step 4: Verify the interop mode still passes (regression)**

In terminal A: `BASE_URL=http://localhost:3000 KV_BACKEND=memory PORT=3000 npm run dev`
In terminal B: `test/e2e/.venv/bin/python test/e2e/relay_smoke.py interop`
Expected: `PASS interop: ...`.

- [ ] **Step 5: Manual real-Google run (the success criterion)**

Prerequisite: Google "Web application" OAuth client created with redirect URI
`http://localhost:3000/callback`, your account a test user, and
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` in `test/e2e/.env` (see README).

In terminal A: `BASE_URL=http://localhost:3000 KV_BACKEND=memory PORT=3000 npm run dev`
In terminal B: `test/e2e/.venv/bin/python test/e2e/relay_smoke.py real`
Then: open the printed URL, grant consent in the browser.
Expected: `PASS real: ...` with a non-empty (masked) access + refresh token.

- [ ] **Step 6: Commit**

```bash
git add test/e2e/relay_smoke.py
git commit -m "test(e2e): real-Google mode — token exchange proves end-to-end relay"
```

---

## Self-Review

**Spec coverage:**
- Goal "real Google round trip" → Task 4 (`real` mode). ✓
- Goal "cross-library interop" → Task 3 (`interop` mode) + Task 2 (format unit tests). ✓
- Contract steps 1–5 → Task 2 (generate), Task 3 (`/session`, `/result`, open), Task 4 (exchange). ✓
- Artifact 1 (`relay_smoke.py` + requirements + README + gitignore) → Tasks 2–4. ✓
- Artifact 2 (`test/loop.test.ts`) → Task 1. ✓
- Google client prerequisite (step 0) → Task 3 README + Task 4 Step 5. ✓
- "Relay code unchanged" → no task modifies `src/`. ✓
- Masked-token hygiene → Task 4 `mask`/`--show`. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. ✓

**Type consistency:** `gen_keypair`/`make_pkce`/`make_pickup`/`open_sealed`/`pkce_challenge` (Task 2) used with identical names/signatures in Tasks 3–4; `create_session`/`poll_result` (Task 3) used unchanged in Task 4; `botPublicKey` and `pickupHash` encodings match the relay's decoders throughout. ✓
