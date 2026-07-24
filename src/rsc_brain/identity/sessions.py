"""Console sessions on the single D11 identity (SPEC-07).

Login verifies the user's argon2 password (SPEC-04) and mints a DB-backed session token, stored
only as a SHA-256 hash. :func:`resolve_session` runs on every console request (no cache), so
logout, expiry, or disabling the user stops the session resolving in well under 5s (FR-4.12) — the
same discipline as PAT resolution. The session is user-scoped (it spans the user's projects),
unlike a project-scoped PAT.
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain import security
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope

SESSION_TTL = dt.timedelta(days=7)
OWNER_ROLE = "owner"


@dataclass(frozen=True, slots=True)
class SessionUser:
    user_id: str
    email: str
    role: str

    @property
    def is_owner(self) -> bool:
        return self.role == OWNER_ROLE


@dataclass(frozen=True, slots=True)
class MembershipInfo:
    project_id: str
    project_slug: str
    role: str
    allowed_topics: tuple[str, ...]
    can_curate: bool


def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


async def login(
    sessionmaker: async_sessionmaker[AsyncSession], email: str, password: str
) -> str | None:
    """Verify credentials on the single D11 identity and mint a session token (shown once).

    Returns ``None`` on any failure (unknown email, wrong password, inactive user) — the caller
    maps that to one indistinguishable 401."""
    async with session_scope(sessionmaker) as session:
        user = await session.scalar(select(models.User).where(models.User.email == email))
        if user is None or user.status != "active" or user.password_hash is None:
            return None
        if not security.verify_password(user.password_hash, password):
            return None
        token = security.mint_token(security.SESSION_PREFIX)
        session.add(
            models.ConsoleSession(
                user_id=user.id,
                token_hash=security.token_hash(token),
                expires_at=_now() + SESSION_TTL,
            )
        )
        return token


async def resolve_session(
    sessionmaker: async_sessionmaker[AsyncSession], token: str
) -> SessionUser | None:
    """Resolve a session token to its user (direct lookup every call). Unknown, revoked, expired,
    or a disabled user all resolve to ``None`` (<5s revocation)."""
    now = _now()
    async with sessionmaker() as session:
        record = await session.scalar(
            select(models.ConsoleSession).where(
                models.ConsoleSession.token_hash == security.token_hash(token)
            )
        )
        if record is None or record.revoked_at is not None:
            return None
        if record.expires_at is not None and record.expires_at < now:
            return None
        user = await session.get(models.User, record.user_id)
        if user is None or user.status != "active":
            return None
        return SessionUser(user_id=str(user.id), email=user.email, role=user.role)


async def logout(sessionmaker: async_sessionmaker[AsyncSession], token: str) -> None:
    async with session_scope(sessionmaker) as session:
        await session.execute(
            update(models.ConsoleSession)
            .where(models.ConsoleSession.token_hash == security.token_hash(token))
            .values(revoked_at=_now())
        )


async def list_memberships(
    sessionmaker: async_sessionmaker[AsyncSession], user_id: str
) -> list[MembershipInfo]:
    """The user's project memberships (slug, role, topics) — drives the project selector."""
    async with sessionmaker() as session:
        rows = await session.execute(
            select(
                models.ProjectMembership.project_id,
                models.Project.slug,
                models.ProjectMembership.role,
                models.ProjectMembership.allowed_topics,
                models.ProjectMembership.can_curate,
            )
            .join(models.Project, models.ProjectMembership.project_id == models.Project.id)
            .where(models.ProjectMembership.user_id == uuid.UUID(user_id))
            .order_by(models.Project.slug)
        )
        return [
            MembershipInfo(
                project_id=str(project_id),
                project_slug=slug,
                role=role,
                allowed_topics=tuple(allowed_topics),
                can_curate=can_curate,
            )
            for project_id, slug, role, allowed_topics, can_curate in rows.all()
        ]


async def list_user_pats(
    sessionmaker: async_sessionmaker[AsyncSession], user_id: str
) -> list[dict[str, object]]:
    """The user's own PATs (across their memberships) — for the 'My connections' view."""
    async with sessionmaker() as session:
        rows = await session.execute(
            select(
                models.PersonalAccessToken.id,
                models.PersonalAccessToken.name,
                models.PersonalAccessToken.created_at,
                models.PersonalAccessToken.expires_at,
                models.PersonalAccessToken.revoked_at,
                models.Project.slug,
            )
            .join(
                models.ProjectMembership,
                models.PersonalAccessToken.membership_id == models.ProjectMembership.id,
            )
            .join(models.Project, models.ProjectMembership.project_id == models.Project.id)
            .where(models.ProjectMembership.user_id == uuid.UUID(user_id))
            .order_by(models.PersonalAccessToken.created_at.desc())
        )
        return [
            {
                "id": str(pat_id),
                "name": name,
                "project": slug,
                "created_at": created_at.isoformat() if created_at else None,
                "expires_at": expires_at.isoformat() if expires_at else None,
                "revoked": revoked_at is not None,
            }
            for pat_id, name, created_at, expires_at, revoked_at, slug in rows.all()
        ]


async def owns_pat(
    sessionmaker: async_sessionmaker[AsyncSession], user_id: str, pat_id: str
) -> bool:
    """True iff ``pat_id`` belongs to a membership of ``user_id`` (authorizes self-revoke)."""
    async with sessionmaker() as session:
        owner = await session.scalar(
            select(models.ProjectMembership.user_id)
            .join(
                models.PersonalAccessToken,
                models.PersonalAccessToken.membership_id == models.ProjectMembership.id,
            )
            .where(models.PersonalAccessToken.id == uuid.UUID(pat_id))
        )
        return owner is not None and str(owner) == user_id


async def membership_for(
    sessionmaker: async_sessionmaker[AsyncSession], user_id: str, project_slug: str
) -> str | None:
    """The user's membership id for a project slug (to issue a PAT there), or None."""
    async with sessionmaker() as session:
        membership_id = await session.scalar(
            select(models.ProjectMembership.id)
            .join(models.Project, models.ProjectMembership.project_id == models.Project.id)
            .where(
                models.ProjectMembership.user_id == uuid.UUID(user_id),
                models.Project.slug == project_slug,
            )
        )
        return str(membership_id) if membership_id is not None else None


async def list_user_connections(
    sessionmaker: async_sessionmaker[AsyncSession], user_id: str
) -> list[dict[str, object]]:
    """The user's OAuth connections (across their memberships) — the 'connected apps' view
    (FR-4.13). One row per issued OAuth token, with the client + project it binds to."""
    async with sessionmaker() as session:
        rows = await session.execute(
            select(
                models.OAuthToken.id,
                models.OAuthClient.client_metadata,
                models.OAuthClient.client_id,
                models.Project.slug,
                models.OAuthToken.expires_at,
                models.OAuthToken.revoked_at,
            )
            .join(models.OAuthClient, models.OAuthToken.client_id == models.OAuthClient.id)
            .join(
                models.ProjectMembership,
                models.OAuthToken.membership_id == models.ProjectMembership.id,
            )
            .join(models.Project, models.ProjectMembership.project_id == models.Project.id)
            .where(models.ProjectMembership.user_id == uuid.UUID(user_id))
            .order_by(models.OAuthToken.id.desc())
        )
        return [
            {
                "id": str(token_id),
                "client": (metadata or {}).get("client_name") or client_id,
                "project": slug,
                "expires_at": expires_at.isoformat() if expires_at else None,
                "revoked": revoked_at is not None,
            }
            for token_id, metadata, client_id, slug, expires_at, revoked_at in rows.all()
        ]


async def owns_connection(
    sessionmaker: async_sessionmaker[AsyncSession], user_id: str, connection_id: str
) -> bool:
    """True iff the OAuth token ``connection_id`` binds to a membership of ``user_id``."""
    async with sessionmaker() as session:
        owner = await session.scalar(
            select(models.ProjectMembership.user_id)
            .join(models.OAuthToken, models.OAuthToken.membership_id == models.ProjectMembership.id)
            .where(models.OAuthToken.id == uuid.UUID(connection_id))
        )
        return owner is not None and str(owner) == user_id


async def revoke_connection(
    sessionmaker: async_sessionmaker[AsyncSession], connection_id: str
) -> None:
    """Revoke an OAuth connection (stops resolving in <5s). Idempotent."""
    async with session_scope(sessionmaker) as session:
        await session.execute(
            update(models.OAuthToken)
            .where(models.OAuthToken.id == uuid.UUID(connection_id))
            .values(revoked_at=_now())
        )


def memberships_payload(memberships: Sequence[MembershipInfo]) -> list[dict[str, object]]:
    return [
        {
            "project": m.project_slug,
            "role": m.role,
            "allowed_topics": list(m.allowed_topics),
            "can_curate": m.can_curate,
        }
        for m in memberships
    ]
