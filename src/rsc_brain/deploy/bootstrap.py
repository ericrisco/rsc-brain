"""Deploy bootstrap (SPEC-18, FR-18.x): the idempotent pieces behind ``brain init``.

``brain init`` = migrate-on-boot (NFR-8) + **first-admin bootstrap**. This module owns the second:
create the first owner (active, argon2 password) + a default-project membership, exactly once, so a
fresh install has a human who can log into the console without touching the database. Re-running is
a no-op (an existing admin is never reset). Secrets are opaque random strings — the only secret the
stack needs is the Postgres password (folded into ``RSC_BRAIN_DATABASE__DSN``); there is no JWT/
signing key to manage (all tokens are opaque, SPEC-10).
"""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain import security
from rsc_brain.identity.service import IdentityService
from rsc_brain.scope import PROJECT_ROLE_ADMIN
from rsc_brain.stores.relational import models

DEFAULT_ADMIN_EMAIL = "admin@rsc-brain.local"


def generate_secret(nbytes: int = 24) -> str:
    """A URL-safe opaque secret (Postgres password / first-admin password)."""
    return secrets.token_urlsafe(nbytes)


#: Where a generated first-admin credential is left for the operator, relative to the data directory.
CREDENTIAL_FILENAME = "first-admin-credential"


def store_generated_credential(data_dir: str | Path, email: str, password: str) -> Path:
    """Write a generated credential to an owner-only file and return its path (R13).

    Printing it was the delivery mechanism, and ``brain init`` is the migrate-on-boot one-shot, so its
    stdout is the ``migrate`` service's log — which AUDIT-034 requires to contain no credential value.
    The Helm path already does this properly by generating into a Secret; on compose and bare metal the
    equivalent is a file only the owner can read, inside the volume the deployment already treats as
    private state.

    Created with mode 0600 from the start (never written world-readable and chmod'ed after), and
    replaced rather than appended so a re-run cannot accumulate old credentials.
    """
    directory = Path(data_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / CREDENTIAL_FILENAME
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(f"email: {email}\npassword: {password}\n")
    path.chmod(0o600)  # explicit: umask does not apply to a file that already existed
    return path


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
    # Two SEPARATE authorities, both required and neither implying the other (AUDIT-020): `owner` on
    # the platform above, and the project-administrator role here. This membership used to be written
    # with `role="admin"` — a value that is not one of the documented project roles
    # (project-admin|member|viewer) and that the capability matrix therefore admits to nothing, so a
    # fresh install's only human was locked out of its own management surface.
    # AUDIT-066: the grant below is a SNAPSHOT of the project's topics, and topics are created
    # lazily during ingestion — so on a fresh install it was empty and stayed empty. The owner
    # ingested a document, asked for it, and got `found: false`, which FR-4.3 requires to be
    # indistinguishable from "nothing there". Four correct claims sat in the database, invisible to
    # the only human on the system. Ensuring the fallback topic exists first is the difference
    # between an install that works and one that looks broken while every invariant holds.
    await identity.ensure_default_topic(project_id)
    await identity.add_membership(
        user_id,
        project_id,
        role=PROJECT_ROLE_ADMIN,
        allowed_topics=tuple(await identity.list_topic_slugs(project_id)),
        can_curate=True,
    )
    return AdminBootstrap(email=email, created=True, generated_password=generated)
