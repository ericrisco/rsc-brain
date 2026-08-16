"""Identity service (SPEC-04): projects, users/invitations, memberships/topics, PATs, agents.

A thin service layer over the SPEC-03 relational store. Passwords are argon2id; bearer tokens
are shown once and stored only as SHA-256 hashes. Deactivating a user or agent revokes its
tokens immediately (revocation is enforced at resolution time by a direct DB lookup, so it
takes effect well under 5s — FR-4.12/14.9).
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain import security
from rsc_brain.scope import Principal, PrincipalType
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope

DEFAULT_PROJECT_SLUG = "default"
#: The topic the ingestion pipeline falls back to when nothing more specific is assigned. It is
#: shared with `PipelineConfig.default_tag` rather than duplicated: if the two drifted, the first
#: admin would be granted a topic nothing is ever tagged with — which fails silently and is
#: indistinguishable from an empty knowledge base (AUDIT-066).
DEFAULT_TOPIC_SLUG = "general"


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

    async def list_projects_for_user(self, user_id: str) -> list[str]:
        """The slugs of the projects ``user_id`` is a member of (AUDIT-020/R01).

        The console needs a project list; it does not need the instance's tenant inventory, so the
        membership join — not a platform-wide listing — is what a project caller reads.
        """
        async with self._sm() as session:
            rows = await session.scalars(
                select(models.Project.slug)
                .join(
                    models.ProjectMembership,
                    models.ProjectMembership.project_id == models.Project.id,
                )
                .where(models.ProjectMembership.user_id == uuid.UUID(user_id))
                .order_by(models.Project.slug)
            )
            return list(rows)

    async def delete_project(self, slug: str, *, data_dir: str | None = None) -> None:
        """Delete a project through the ONE all-store orchestrator (AUDIT-026 / R44).

        This used to delete the ``projects`` row and rely on cascades — so the AGE graph and the stored
        source documents survived, and `brain forget --whole-project` (which did drop the graph) removed
        more than `brain projects delete` did. Two routes, two meanings of "delete", and the operator
        could not tell which they had used.
        """
        from rsc_brain.knowledge.gdpr import hard_delete_project

        if slug == DEFAULT_PROJECT_SLUG:
            raise ValueError("the 'default' project cannot be deleted")
        async with self._sm() as session:
            project_id = await session.scalar(
                select(models.Project.id).where(models.Project.slug == slug)
            )
        if project_id is None:
            return
        scope = Principal(id="cli", type=PrincipalType.HUMAN, can_curate=True).scope_for(
            str(project_id)
        )
        await hard_delete_project(self._sm, scope, data_dir=data_dir)

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
        """Attach a user to a project. Unique per (user, project) — SPEC-04 §3.1.

        AUDIT-074: for the whole of the product's life this had exactly one caller, the bootstrap of
        the FIRST owner. No CLI command and no API route reached it, so an invited user who set their
        password belonged to no project, saw nothing, and could not be given anything — the operator
        surfaces added in AUDIT-073 correctly refuse to grant a topic without a membership, which is
        how this surfaced. The only route out was a direct database write.
        """
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

    async def remove_membership(self, user_id: str, project_id: str) -> bool:
        """Detach a user from a project; ``False`` when there was nothing to detach.

        AUDIT-074: access that cannot be withdrawn is not access control. Deleting the membership
        cascades to that principal's PATs (the FK is ``ON DELETE CASCADE``), so revocation of the
        credentials issued under it is not a second step someone can forget.
        """
        async with session_scope(self._sm) as session:
            membership = await session.scalar(
                select(models.ProjectMembership).where(
                    models.ProjectMembership.user_id == uuid.UUID(user_id),
                    models.ProjectMembership.project_id == uuid.UUID(project_id),
                )
            )
            if membership is None:
                return False
            await session.delete(membership)
            return True

    async def list_memberships(self, project_id: str) -> list[dict[str, object]]:
        """Who belongs to a project, with the role and authority each holds (AUDIT-074).

        An administrator has to be able to see this before granting anything: AUDIT-073's grant
        refuses without a membership, and nothing reported whether one existed.
        """
        async with self._sm() as session:
            rows = (
                await session.execute(
                    select(
                        models.ProjectMembership.user_id,
                        models.User.email,
                        models.ProjectMembership.role,
                        models.ProjectMembership.allowed_topics,
                        models.ProjectMembership.can_curate,
                    )
                    .join(models.User, models.User.id == models.ProjectMembership.user_id)
                    .where(models.ProjectMembership.project_id == uuid.UUID(project_id))
                    .order_by(models.User.email)
                )
            ).all()
            return [
                {
                    "user_id": str(user_id),
                    "email": email,
                    "role": role,
                    "allowed_topics": list(topics),
                    "can_curate": can_curate,
                }
                for user_id, email, role, topics, can_curate in rows
            ]

    async def list_topic_slugs(self, project_id: str) -> list[str]:
        """The project's topic slugs, ordered — the set an explicit grant can draw from."""
        async with self._sm() as session:
            rows = await session.scalars(
                select(models.Topic.slug)
                .where(models.Topic.project_id == uuid.UUID(project_id))
                .order_by(models.Topic.slug)
            )
            return list(rows)

    async def grant_topics(
        self, user_id: str, project_id: str, slugs: Sequence[str]
    ) -> tuple[str, ...]:
        """Add ``slugs`` to a membership's topic authority, idempotently; returns the new set.

        Topic authority stays EXPLICIT for every role, project administrators included (AUDIT-020:
        empty authority is never all topics, and R01 holds that even the highest project role sees
        only the topics it was granted). So a topic someone must be able to act on is recorded on
        their membership rather than inferred from their role.

        AUDIT-073: this used to merge whatever strings it was handed. SPEC-04 §3.2 requires that
        assigning a topic from another project fail, and authority is the one field that must never
        take an unvalidated write — a slug that names nothing is authority over nothing today and
        authority over whatever later claims that name.

        A missing membership still returns ``()`` rather than raising: an agent principal has no
        membership, and `create_topic` self-grants through this method on both principal types. The
        operator surfaces check the membership themselves so the refusal is loud where a human is
        watching.
        """
        async with session_scope(self._sm) as session:
            known = set(
                await session.scalars(
                    select(models.Topic.slug).where(
                        models.Topic.project_id == uuid.UUID(project_id)
                    )
                )
            )
            unknown = [slug for slug in slugs if slug not in known]
            if unknown:
                raise ValueError(
                    f"not topics of this project: {', '.join(sorted(unknown))}. "
                    "A grant may only name a topic of the membership's own project (SPEC-04 §3.2)."
                )
            membership = await session.scalar(
                select(models.ProjectMembership).where(
                    models.ProjectMembership.user_id == uuid.UUID(user_id),
                    models.ProjectMembership.project_id == uuid.UUID(project_id),
                )
            )
            if membership is None:
                return ()
            merged = list(dict.fromkeys([*membership.allowed_topics, *slugs]))
            membership.allowed_topics = merged
            return tuple(merged)

    async def revoke_topics(
        self, user_id: str, project_id: str, slugs: Sequence[str]
    ) -> tuple[str, ...]:
        """Remove ``slugs`` from a membership's topic authority; returns the remaining set.

        AUDIT-073: `create_topic`'s own docstring describes the grant as "visible and revocable", and
        nothing revoked it — authority could only ever grow. Withdrawing access is the half of a
        permission model that gets exercised when someone changes team or leaves one, and it was the
        half that did not exist.

        Idempotent: revoking a topic nobody holds is not an error. Unlike a grant, no taxonomy check
        applies — removing a slug that names nothing is exactly the cleanup someone would want.
        """
        async with session_scope(self._sm) as session:
            membership = await session.scalar(
                select(models.ProjectMembership).where(
                    models.ProjectMembership.user_id == uuid.UUID(user_id),
                    models.ProjectMembership.project_id == uuid.UUID(project_id),
                )
            )
            if membership is None:
                return ()
            dropped = set(slugs)
            remaining = [slug for slug in membership.allowed_topics if slug not in dropped]
            membership.allowed_topics = remaining
            return tuple(remaining)

    async def membership_topics(self, user_id: str, project_id: str) -> tuple[str, ...] | None:
        """A membership's current topic authority, or ``None`` when there is no such membership.

        AUDIT-073: the operator surfaces need to tell "granted nothing" apart from "no such
        membership" so they can refuse loudly instead of reporting an empty success.
        """
        async with self._sm() as session:
            membership = await session.scalar(
                select(models.ProjectMembership).where(
                    models.ProjectMembership.user_id == uuid.UUID(user_id),
                    models.ProjectMembership.project_id == uuid.UUID(project_id),
                )
            )
            return None if membership is None else tuple(membership.allowed_topics)

    async def ensure_default_topic(self, project_id: str) -> str:
        """Create the fallback topic if absent; return its id. Idempotent.

        The first admin's topic grant is a SNAPSHOT taken at bootstrap. Topics are created lazily
        during ingestion, so on a fresh install the snapshot was empty and froze that way: the owner
        ingested a document, asked for it, and got `found: false` — correctly indistinguishable from
        "nothing there" (FR-4.3), and therefore impossible to diagnose. Ensuring the fallback topic
        exists first is what makes the snapshot non-empty.
        """
        async with session_scope(self._sm) as session:
            existing = await session.scalar(
                select(models.Topic.id).where(
                    models.Topic.project_id == uuid.UUID(project_id),
                    models.Topic.slug == DEFAULT_TOPIC_SLUG,
                )
            )
            if existing is not None:
                return str(existing)
        try:
            return await self.create_topic(project_id, DEFAULT_TOPIC_SLUG, "General")
        except IntegrityError:
            # Check-then-insert spans two transactions, so another `brain init` — or an api and a
            # worker booting together — can win the race between them. The unique constraint is the
            # real arbiter; losing to it means the topic now exists, which is the outcome asked for.
            async with self._sm() as session:
                existing = await session.scalar(
                    select(models.Topic.id).where(
                        models.Topic.project_id == uuid.UUID(project_id),
                        models.Topic.slug == DEFAULT_TOPIC_SLUG,
                    )
                )
            if existing is None:  # pragma: no cover - the constraint fired for another reason
                raise
            return str(existing)

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
