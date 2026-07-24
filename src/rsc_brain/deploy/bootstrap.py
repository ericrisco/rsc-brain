"""Deploy bootstrap (SPEC-18, FR-18.x): the idempotent pieces behind ``brain init``.

``brain init`` = migrate-on-boot (NFR-8) + **first-admin bootstrap**. This module owns the second:
create the first owner (active, argon2 password) + a default-project membership, exactly once, so a
fresh install has a human who can log into the console without touching the database. Re-running is
a no-op (an existing admin is never reset). Secrets are opaque random strings — the only secret the
stack needs is the Postgres password (folded into ``RSC_BRAIN_DATABASE__DSN``); there is no JWT/
signing key to manage (all tokens are opaque, SPEC-10).
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain import security
from rsc_brain.identity.service import IdentityService
from rsc_brain.stores.relational import models

DEFAULT_ADMIN_EMAIL = "admin@rsc-brain.local"


def generate_secret(nbytes: int = 24) -> str:
    """A URL-safe opaque secret (Postgres password / first-admin password)."""
    return secrets.token_urlsafe(nbytes)


@dataclass(frozen=True, slots=True)
class AdminBootstrap:
    email: str
    created: bool
    generated_password: str | None  # set ONLY when we generated one — show it once, never stored


async def ensure_first_admin(
    sessionmaker: async_sessionmaker[AsyncSession],
    *,
    email: str = DEFAULT_ADMIN_EMAIL,
    password: str | None = None,
) -> AdminBootstrap:
    """Create the first admin (owner + active + argon2 password + default-project membership) if no
    user with ``email`` exists. Idempotent: an existing user is left untouched (no password reset).
    A missing password is generated and returned once (the "shown in logs" path, FR-18.x)."""
    async with sessionmaker() as session:
        existing = await session.scalar(select(models.User.id).where(models.User.email == email))
    if existing is not None:
        return AdminBootstrap(email=email, created=False, generated_password=None)

    generated: str | None = None
    if not password:
        password = generate_secret()
        generated = password

    async with sessionmaker() as session:
        user = models.User(
            email=email,
            role="owner",
            status="active",
            password_hash=security.hash_password(password),
        )
        session.add(user)
        await session.flush()
        user_id = str(user.id)
        await session.commit()

    identity = IdentityService(sessionmaker)
    project_id = await identity.ensure_default_project()
    await identity.add_membership(user_id, project_id, role="admin", can_curate=True)
    return AdminBootstrap(email=email, created=True, generated_password=generated)
