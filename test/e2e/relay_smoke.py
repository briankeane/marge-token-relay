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
import sys
import time
import webbrowser

import requests
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


def poll_result(base, session_id, secret, timeout=180, interval=5):
    # Poll at 5s (relay rate-limits /result to ~30 req/min); 30s consent waits would
    # otherwise exhaust the budget at a tighter interval.
    deadline = time.time() + timeout
    while time.time() < deadline:
        resp = requests.post(
            f"{base}/result",
            json={"sessionId": session_id, "pickup_secret": secret},
            timeout=30,
        )
        # 204 = code not ready yet; 429 = relay rate-limited our polling. Both mean
        # "wait and retry" rather than fail.
        if resp.status_code in (204, 429):
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


def require_env(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        print(f"FAIL: required env var {name} is not set (see test/e2e/README.md)")
        sys.exit(2)
    return val


def mask(value: str) -> str:
    if not value:
        return "<missing>"
    return f"<redacted, {len(value)} chars>"


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

    # create_session/poll_result/exchange_code raise RuntimeError on unexpected
    # relay/Google responses, and poll_result raises TimeoutError if consent is not
    # completed in time. Surface those as the script's FAIL: ... convention rather
    # than a raw traceback.
    try:
        session_id, authorize_url = create_session(
            base, client_id, scopes, state, challenge, pickup_hash, bot_pub
        )
        print(f"\nOpen this URL in your browser and grant consent:\n\n  {authorize_url}\n")
        if os.environ.get("NO_BROWSER") != "1":
            try:
                webbrowser.open(authorize_url)
            except Exception:
                pass

        poll_timeout = int(os.environ.get("POLL_TIMEOUT_SECONDS", "180"))
        print(f"Waiting for the sealed code (polling /result, up to {poll_timeout}s)...")
        result = poll_result(base, session_id, secret, timeout=poll_timeout)
        if "error" in result:
            print(f"FAIL: Google returned an OAuth error: {result['error']}")
            sys.exit(1)

        code = open_sealed(priv, result["sealedCode"])
        print("Opened the sealed code; redeeming it at Google's token endpoint...")
        tokens = exchange_code(code, client_id, client_secret, verifier, redirect_uri)
    except (TimeoutError, RuntimeError) as e:
        print(f"FAIL: {e}")
        sys.exit(1)

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


if __name__ == "__main__":
    main()
