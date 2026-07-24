"""Identity service (SPEC-04): projects, users/invitations, memberships/topics, PATs, agents.

A thin service layer over the SPEC-03 relational store. Passwords are argon2id; bearer tokens
are shown once and stored only as SHA-256 hashes. Deactivating a user or agent revokes its
tokens immediately (revocation is enforced at resolution time by a direct DB lookup, so it
takes effect well under 5s — FR-4.12/14.9).
"""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain import security
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope

DEFAULT_PROJECT_SLUG = "default"


def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


@dataclass(frozen=True, slots=True)
class Issued:
    """A newly issued credential: the id plus the plaintext token (shown exactly once)."""

    id: str
    token: str


class IdentityService:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sm = sessionmaker

    # --- projects ------------------------------------------------------------

    async def create_project(self, slug: str, name: str) -> str:
        async with session_scope(self._sm) as session:
            project = models.Project(slug=slug, name=name)
            session.add(project)
            await session.flush()
            return str(project.id)

    async def ensure_default_project(self) -> str:
        async with self._sm() as session:
            existing = await session.scalar(
                select(models.Project.id).where(models.Project.slug == DEFAULT_PROJECT_SLUG)
            )
        if existing is not None:
            return str(existing)
        return await self.create_project(DEFAULT_PROJECT_SLUG, "Default")

    async def list_projects(self) -> list[str]:
        async with self._sm() as session:
            rows = await session.scalars(select(models.Project.slug).order_by(models.Project.slug))
            return list(rows)

    async def delete_project(self, slug: str) -> None:
        if slug == DEFAULT_PROJECT_SLUG:
            raise ValueError("the 'default' project cannot be deleted")
        async with session_scope(self._sm) as session:
            project = await session.scalar(
                select(models.Project).where(models.Project.slug == slug)
            )
            if project is not None:
                await session.delete(project)

    # --- users & invitations -------------------------------------------------

    async def invite_user(self, email: str, *, role: str = "member") -> Issued:
        """Create an invited user and a single-use invitation token (returned once)."""
        token = security.mint_token(security.INVITATION_PREFIX)
        async with session_scope(self._sm) as session:
            user = models.User(email=email, role=role, status="invited")
            session.add(user)
            await session.flush()
            session.add(
                models.Invitation(
                    user_id=user.id,
                    token_hash=security.token_hash(token),
                    expires_at=_now() + dt.timedelta(days=7),
                )
            )
            return Issued(id=str(user.id), token=token)

    async def accept_invitation(self, token: str, password: str) -> str:
        """Consume a single-use invitation, set the password (argon2), activate the user."""
        async with session_scope(self._sm) as session:
            invitation = await session.scalar(
                select(models.Invitation).where(
                    models.Invitation.token_hash == security.token_hash(token)
                )
            )
            if invitation is None or invitation.used_at is not None:
                raise ValueError("invalid or already-used invitation")
            if invitation.expires_at is not None and invitation.expires_at < _now():
                raise ValueError("invitation expired")
            invitation.used_at = _now()
            user = await session.get(models.User, invitation.user_id)
            if user is None:
                raise ValueError("invitation user missing")
            user.password_hash = security.hash_password(password)
            user.status = "active"
            return str(user.id)

    async def deactivate_user(self, user_id: str) -> None:
        """Disable a user and revoke ALL their credentials — PATs, OAuth tokens, and console
        sessions — in one transaction (FR-4.12). The disabled status alone already stops every
        credential resolving in <5s (the resolver re-checks it per request); marking ``revoked_at``
        makes the revocation explicit + durable + auditable."""
        uid = uuid.UUID(user_id)
        now = _now()
        async with session_scope(self._sm) as session:
            await session.execute(
                update(models.User).where(models.User.id == uid).values(status="disabled")
            )
            membership_ids = (
                await session.scalars(
                    select(models.ProjectMembership.id).where(
                        models.ProjectMembership.user_id == uid
                    )
                )
            ).all()
            if membership_ids:
                await session.execute(
                    update(models.PersonalAccessToken)
                    .where(models.PersonalAccessToken.membership_id.in_(membership_ids))
                    .values(revoked_at=now)
                )
                await session.execute(
                    update(models.OAuthToken)
                    .where(models.OAuthToken.membership_id.in_(membership_ids))
                    .values(revoked_at=now)
                )
            await session.execute(
                update(models.ConsoleSession)
                .where(models.ConsoleSession.user_id == uid)
                .values(revoked_at=now)
            )

    async def request_password_reset(self, email: str) -> Issued | None:
        """Issue a single-use password-reset token for an active user (same mechanism as an
        invitation, ``kind='password_reset'``). Returns ``None`` for an unknown/inactive email so
        the caller cannot probe which addresses exist."""
        token = security.mint_token(security.INVITATION_PREFIX)
        async with session_scope(self._sm) as session:
            user = await session.scalar(select(models.User).where(models.User.email == email))
            if user is None or user.status != "active":
                return None
            session.add(
                models.Invitation(
                    user_id=user.id,
                    token_hash=security.token_hash(token),
                    expires_at=_now() + dt.timedelta(hours=1),
                    kind="password_reset",
                )
            )
            return Issued(id=str(user.id), token=token)

    async def reset_password(self, token: str, new_password: str) -> str:
        """Consume a single-use reset token, set the new argon2 password, and revoke the user's
        console sessions (a reset invalidates old logins). Returns the user id."""
        async with session_scope(self._sm) as session:
            reset = await session.scalar(
                select(models.Invitation).where(
                    models.Invitation.token_hash == security.token_hash(token),
                    models.Invitation.kind == "password_reset",
                )
            )
            if reset is None or reset.used_at is not None:
                raise ValueError("invalid or already-used reset token")
            if reset.expires_at is not None and reset.expires_at < _now():
                raise ValueError("reset token expired")
            reset.used_at = _now()
            user = await session.get(models.User, reset.user_id)
            if user is None or user.status != "active":
                raise ValueError("reset user missing or inactive")
            user.password_hash = security.hash_password(new_password)
            await session.execute(
                update(models.ConsoleSession)
                .where(models.ConsoleSession.user_id == user.id)
                .values(revoked_at=_now())
            )
            return str(user.id)

    # --- memberships & topics ------------------------------------------------

    async def add_membership(
        self,
        user_id: str,
        project_id: str,
        *,
        role: str = "member",
        allowed_topics: tuple[str, ...] = (),
        can_curate: bool = False,
    ) -> str:
        async with session_scope(self._sm) as session:
            membership = models.ProjectMembership(
                user_id=uuid.UUID(user_id),
                project_id=uuid.UUID(project_id),
                role=role,
                allowed_topics=list(allowed_topics),
                can_curate=can_curate,
            )
            session.add(membership)
            await session.flush()
            return str(membership.id)

    async def create_topic(
        self, project_id: str, slug: str, name: str, *, sensitivity: int = 0
    ) -> str:
        async with session_scope(self._sm) as session:
            topic = models.Topic(
                project_id=uuid.UUID(project_id), slug=slug, name=name, sensitivity=sensitivity
            )
            session.add(topic)
            await session.flush()
            return str(topic.id)

    # --- personal access tokens ---------------------------------------------

    async def issue_pat(self, membership_id: str, *, name: str | None = None) -> Issued:
        token = security.mint_token(security.PAT_PREFIX)
        async with session_scope(self._sm) as session:
            pat = models.PersonalAccessToken(
                membership_id=uuid.UUID(membership_id),
                token_hash=security.token_hash(token),
                name=name,
            )
            session.add(pat)
            await session.flush()
            return Issued(id=str(pat.id), token=token)

    async def revoke_pat(self, pat_id: str) -> None:
        async with session_scope(self._sm) as session:
            await session.execute(
                update(models.PersonalAccessToken)
                .where(models.PersonalAccessToken.id == uuid.UUID(pat_id))
                .values(revoked_at=_now())
            )

    # --- agents (service accounts) -------------------------------------------

    async def create_agent(
        self,
        project_id: str,
        owner_user_id: str,
        name: str,
        *,
        allowed_topics: tuple[str, ...] = (),
        description: str | None = None,
    ) -> str:
        async with session_scope(self._sm) as session:
            agent = models.Agent(
                project_id=uuid.UUID(project_id),
                owner_user_id=uuid.UUID(owner_user_id),
                name=name,
                description=description,
                allowed_topics=list(allowed_topics),
            )
            session.add(agent)
            await session.flush()
            return str(agent.id)

    async def issue_agent_pat(self, agent_id: str, *, name: str | None = None) -> Issued:
        token = security.mint_token(security.PAT_PREFIX)
        async with session_scope(self._sm) as session:
            pat = models.PersonalAccessToken(
                agent_id=uuid.UUID(agent_id),
                token_hash=security.token_hash(token),
                name=name,
            )
            session.add(pat)
            await session.flush()
            return Issued(id=str(pat.id), token=token)

    async def deactivate_agent(self, agent_id: str) -> None:
        aid = uuid.UUID(agent_id)
        async with session_scope(self._sm) as session:
            await session.execute(
                update(models.Agent).where(models.Agent.id == aid).values(status="disabled")
            )
            await session.execute(
                update(models.PersonalAccessToken)
                .where(models.PersonalAccessToken.agent_id == aid)
                .values(revoked_at=_now())
            )
