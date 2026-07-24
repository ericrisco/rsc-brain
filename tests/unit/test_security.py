"""Unit tests for credential primitives (SPEC-04)."""

from __future__ import annotations

from rsc_brain.security import (
    PAT_PREFIX,
    hash_password,
    mint_token,
    token_hash,
    verify_password,
)


def test_password_hash_is_argon2id_and_roundtrips() -> None:
    hashed = hash_password("correct horse battery staple")
    assert hashed.startswith("$argon2id$")
    assert verify_password(hashed, "correct horse battery staple")
    assert not verify_password(hashed, "wrong password")


def test_verify_password_never_raises_on_garbage() -> None:
    assert verify_password("not-a-valid-hash", "anything") is False


def test_mint_token_is_prefixed_and_unique() -> None:
    a = mint_token(PAT_PREFIX)
    b = mint_token(PAT_PREFIX)
    assert a.startswith("ck_") and b.startswith("ck_")
    assert a != b


def test_token_hash_is_stable_hex_sha256() -> None:
    token = mint_token(PAT_PREFIX)
    digest = token_hash(token)
    assert digest == token_hash(token)
    assert len(digest) == 64 and all(c in "0123456789abcdef" for c in digest)
    assert digest != token  # only the hash is ever stored
