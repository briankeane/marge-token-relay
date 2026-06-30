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
