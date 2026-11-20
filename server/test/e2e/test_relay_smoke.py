import base64
import hashlib

from nacl.public import PrivateKey, SealedBox

from relay_smoke import pkce_challenge, make_pkce, make_pickup, gen_keypair, open_sealed


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


def test_open_sealed_round_trips_a_standard_base64_sealed_box():
    # Mirrors the relay: seal a code to the bot's public key with a NaCl SealedBox
    # (== libsodium crypto_box_seal) and standard-base64-encode it, exactly as the
    # relay's seal() does. open_sealed must decode + decrypt + utf-8 back to the code.
    priv = PrivateKey.generate()
    code = "4/0AaUthorization-code-EXAMPLE"
    sealed = SealedBox(priv.public_key).encrypt(code.encode("utf-8"))
    sealed_b64 = base64.standard_b64encode(sealed).decode("ascii")
    assert open_sealed(priv, sealed_b64) == code
