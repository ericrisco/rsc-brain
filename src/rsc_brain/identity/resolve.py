"""Resolve a presented bearer token to a :class:`ProjectScope` (SPEC-04).

This is the ONLY way a request obtains scope — the project is never taken from client input
(FR-12.3). Resolution is a **direct database lookup on every call** (no cache), so revoking or
disabling a token/user/agent takes effect immediately, well under 5s (FR-4.12/14.9). Unknown,
revoked, expired, or disabled principals all resolve to ``None`` — the caller maps that to the
same indistinguishable ``found:false`` (FR-4.3).
"""

from __future__ import annotations

import datetime as dt

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain import security
from rsc_brain.scope import PrincipalType, ProjectScope
from rsc_brain.stores.relational import models


async def resolve_scope(
    sessionmaker: async_sessionmaker[AsyncSession], token: str
) -> ProjectScope | None:
    now = dt.datetime.now(dt.UTC)
    async with sessionmaker() as session:
        pat = await session.scalar(
            select(models.PersonalAccessToken).where(
                models.PersonalAccessToken.token_hash == security.token_hash(token)
            )
        )
        if pat is None or pat.revoked_at is not None:
            return None
        if pat.expires_at is not None and pat.expires_at < now:
            return None

        if pat.membership_id is not None:
            membership = await session.get(models.ProjectMembership, pat.membership_id)
            if membership is None:
                return None
            user = await session.get(models.User, membership.user_id)
            if user is None or user.status != "active":
                return None
            return ProjectScope(
                principal_id=str(user.id),
                principal_type=PrincipalType.HUMAN,
                project_id=str(membership.project_id),
                allowed_topics=frozenset(membership.allowed_topics),
                can_curate=membership.can_curate,
            )

        if pat.agent_id is not None:
            agent = await session.get(models.Agent, pat.agent_id)
            if agent is None or agent.status != "active":
                return None
            return ProjectScope(
                principal_id=str(agent.id),
                principal_type=PrincipalType.AGENT,
                project_id=str(agent.project_id),
                allowed_topics=frozenset(agent.allowed_topics),
                can_curate=False,
            )

        return None
