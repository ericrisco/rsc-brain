"""Resolve a presented bearer token to a :class:`ProjectScope` (SPEC-04, extended by SPEC-10).

This is the ONLY way a request obtains scope — the project is never taken from client input
(FR-12.3). Resolution is a **direct database lookup on every call** (no cache), so revoking or
disabling a token/user/agent takes effect immediately, well under 5s (FR-4.12/14.9). Unknown,
revoked, expired, or disabled principals all resolve to ``None`` — the caller maps that to the
same indistinguishable ``found:false`` (FR-4.3).

Two token kinds resolve here, both opaque and hashed at rest: a **PAT** (``ck_…``, SPEC-04) and an
**OAuth 2.1 access token** (SPEC-10, minted by the Authlib authorization server). Both land on a
``project_memberships`` (or agent) row, so the scope-from-token guarantee is identical regardless
of how the caller authenticated.
"""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import replace

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain import security
from rsc_brain.scope import PROJECT_ROLE_AGENT, PrincipalType, ProjectScope
from rsc_brain.stores.relational import models


async def resolve_scope(
    sessionmaker: async_sessionmaker[AsyncSession], token: str
) -> ProjectScope | None:
    now = dt.datetime.now(dt.UTC)
    token_hash = security.token_hash(token)
    async with sessionmaker() as session:
        scope = await _resolve_pat(session, token_hash, now)
        if scope is not None:
            return scope
        return await _resolve_oauth(session, token_hash, now)


async def _resolve_pat(
    session: AsyncSession, token_hash: str, now: dt.datetime
) -> ProjectScope | None:
    pat = await session.scalar(
        select(models.PersonalAccessToken).where(
            models.PersonalAccessToken.token_hash == token_hash
        )
    )
    if pat is None or pat.revoked_at is not None:
        return None
    if pat.expires_at is not None and pat.expires_at < now:
        return None

    if pat.membership_id is not None:
        return await _membership_scope(session, pat.membership_id)

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
            # An agent holds no membership and no platform role: it can never satisfy a
            # console/management capability (AUDIT-020).
            role=PROJECT_ROLE_AGENT,
        )

    return None


async def _resolve_oauth(
    session: AsyncSession, token_hash: str, now: dt.datetime
) -> ProjectScope | None:
    """An OAuth 2.1 access token (SPEC-10) → its bound membership scope. The token is opaque here;
    Authlib issued it, but resolving it is just a hash lookup, so this path is fully async."""
    oauth = await session.scalar(
        select(models.OAuthToken).where(models.OAuthToken.access_token_hash == token_hash)
    )
    if oauth is None or oauth.revoked_at is not None:
        return None
    if oauth.expires_at is not None and oauth.expires_at < now:
        return None
    return await _membership_scope(session, oauth.membership_id)


async def resolve_delegated_scope(
    sessionmaker: async_sessionmaker[AsyncSession], agent_scope: ProjectScope, user_id: str
) -> ProjectScope | None:
    """Resolve an agent's ``on_behalf_of`` delegation (SPEC-11, FR-14.2).

    The delegated user must exist, be active, and be a member of the **agent's project**;
    otherwise ``None`` (the caller maps that to ``AUTH_INVALID``). Effective permissions are the
    **intersection** ``topics(agent) ∩ topics(user)`` — never a broadening, never a project change.
    The principal stays the agent (audit records both the agent and ``on_behalf_of``)."""
    if agent_scope.principal_type is not PrincipalType.AGENT:
        return None
    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        return None
    async with sessionmaker() as session:
        user = await session.get(models.User, uid)
        if user is None or user.status != "active":
            return None
        membership = await session.scalar(
            select(models.ProjectMembership).where(
                models.ProjectMembership.user_id == uid,
                models.ProjectMembership.project_id == uuid.UUID(agent_scope.project_id),
            )
        )
        if membership is None:
            return None
        return replace(
            agent_scope,
            allowed_topics=agent_scope.allowed_topics & frozenset(membership.allowed_topics),
            can_curate=agent_scope.can_curate and membership.can_curate,
            on_behalf_of=user_id,
        )


async def _membership_scope(session: AsyncSession, membership_id: uuid.UUID) -> ProjectScope | None:
    membership = await session.get(models.ProjectMembership, membership_id)
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
        # The two authorities travel separately and are never conflated (AUDIT-020/R03).
        role=membership.role,
        platform_role=user.role,
    )
