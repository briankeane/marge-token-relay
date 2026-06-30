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
