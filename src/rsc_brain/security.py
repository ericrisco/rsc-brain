"""Credential primitives: argon2id password hashing and opaque bearer tokens.

Passwords are hashed with argon2id. Bearer tokens (PATs `ck_…`, invitations `inv_…`) are
minted with a CSPRNG and only their SHA-256 hash is ever stored — the plaintext is shown to
the user once and never persisted (FR-4.7 / FR-4.1). Verification hashes the presented token
and compares to the stored hash.
"""

from __future__ import annotations

import hashlib
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

PAT_PREFIX = "ck_"
INVITATION_PREFIX = "inv_"
_TOKEN_BYTES = 32

_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    """Return an argon2id hash for ``password``."""
    return _hasher.hash(password)


def verify_password(stored_hash: str, password: str) -> bool:
    """True iff ``password`` matches ``stored_hash``. Never raises on mismatch."""
    try:
        return _hasher.verify(stored_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def mint_token(prefix: str) -> str:
    """Mint an opaque bearer token with the given prefix (the plaintext, shown once)."""
    return f"{prefix}{secrets.token_urlsafe(_TOKEN_BYTES)}"


def token_hash(token: str) -> str:
    """SHA-256 hex digest of a bearer token — the only form stored in the database."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
