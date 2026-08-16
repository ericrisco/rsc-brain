"""Versioned, audited console-management HTTP surface (UX-SPEC-01 / T006).

The router is registered before the legacy admin router.  It owns the governance resources whose
contract requires optimistic versions, durable idempotency and typed denial envelopes; the legacy
router continues to serve the remaining knowledge-control endpoints.
"""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse
from fastapi.security import HTTPBearer
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain import audit as audit_mod
from rsc_brain import security
from rsc_brain.authorization import Allow, Capability, decide
from rsc_brain.identity import management as commands
from rsc_brain.identity.resolve import resolve_scope
from rsc_brain.identity.sessions import SessionUser, resolve_session
from rsc_brain.mcp.auth import RateLimitedError
from rsc_brain.mcp.quotas import QuotaService
from rsc_brain.scope import PlatformIdentityScope, Principal, PrincipalType, ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope

_bearer = HTTPBearer(auto_error=False)
_PROJECT_ROLES = {"project-admin", "member", "viewer"}
_PLATFORM_ROLES = {"owner", "admin", "member"}
_ARRAY_MAX = 100
_SLUG_PATTERN = r"^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$"
_EMAIL_PATTERN = r"^[^\s@]+@[^\s@]+\.[^\s@]+$"


class CommandBody(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProjectCreate(CommandBody):
    slug: str = Field(min_length=1, max_length=128, pattern=_SLUG_PATTERN)
    name: str = Field(min_length=1, max_length=512)
    settings: dict[str, object] = Field(default_factory=dict)


class ProjectUpdate(CommandBody):
    expected_version: int = Field(ge=1, strict=True)
    name: str | None = Field(default=None, min_length=1, max_length=512)
    settings: dict[str, object] | None = None


class MembershipCreate(CommandBody):
    user_id: str = Field(max_length=64)
    role: str = Field(max_length=32)
    allowed_topics: list[str] = Field(default_factory=list, max_length=_ARRAY_MAX)
    can_curate: bool = False

    @field_validator("allowed_topics")
    @classmethod
    def unique_topics(cls, value: list[str]) -> list[str]:
        return list(dict.fromkeys(value))


class MembershipUpdate(CommandBody):
    expected_version: int = Field(ge=1, strict=True)
    role: str | None = Field(default=None, max_length=32)
    allowed_topics: list[str] | None = Field(default=None, max_length=_ARRAY_MAX)
    can_curate: bool | None = None

    @field_validator("allowed_topics")
    @classmethod
    def unique_topics(cls, value: list[str] | None) -> list[str] | None:
        return None if value is None else list(dict.fromkeys(value))


class TopicCreate(CommandBody):
    slug: str = Field(min_length=1, max_length=128, pattern=_SLUG_PATTERN)
    name: str = Field(min_length=1, max_length=512)
    sensitivity: int = Field(default=0, ge=0, le=10)
    hard_window_days: int | None = Field(default=None, ge=1)


class TopicUpdate(CommandBody):
    expected_version: int = Field(ge=1, strict=True)
    name: str | None = Field(default=None, min_length=1, max_length=512)
    sensitivity: int | None = Field(default=None, ge=0, le=10)
    hard_window_days: int | None = Field(default=None, ge=1)


class CredentialCreate(CommandBody):
    name: str | None = Field(default=None, max_length=512)
    kind: str = Field(default="pat", max_length=32)


class VersionedCommand(CommandBody):
    expected_version: int = Field(ge=1, strict=True)


class UserInvite(CommandBody):
    email: str = Field(min_length=3, max_length=512, pattern=_EMAIL_PATTERN)
    platform_role: str = Field(default="member", max_length=32)
    project_role: str = Field(default="member", max_length=32)
    allowed_topics: list[str] = Field(default_factory=list, max_length=_ARRAY_MAX)
    can_curate: bool = False

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        return value.casefold()

    @field_validator("allowed_topics")
    @classmethod
    def unique_topics(cls, value: list[str]) -> list[str]:
        return list(dict.fromkeys(value))


class ImpactCommand(CommandBody):
    impact_acknowledged: bool


class DisableCommand(ImpactCommand):
    expected_status: str


class InvitationAccept(CommandBody):
    token: str
    password: str = Field(min_length=12, max_length=1024)


class PasswordResetComplete(CommandBody):
    token: str
    new_password: str = Field(min_length=12, max_length=1024)


class Replayable(BaseModel):
    replayed: bool | None = None


class ProjectState(BaseModel):
    id: str
    slug: str
    name: str
    settings: dict[str, object]
    status: str
    version: int


class ProjectInventoryState(ProjectState):
    membership_count: int


class ProjectInventory(BaseModel):
    projects: list[ProjectInventoryState]


class ProjectEnvelope(Replayable):
    project: ProjectState
    audit_correlation: int


class ProjectTransition(Replayable):
    before: ProjectState
    after: ProjectState
    audit_correlation: int


class ProjectImpact(BaseModel):
    project: ProjectState
    version: int
    dependencies: dict[str, int]
    can_delete: bool
    confirmation: str


class ProjectDeleteEnvelope(Replayable):
    project: str
    status: str
    audit_correlation: int


class IdentityState(BaseModel):
    id: str
    email: str
    status: str
    version: int


class MembershipState(BaseModel):
    id: str
    user_id: str
    role: str
    allowed_topics: list[str]
    can_curate: bool
    status: str
    version: int


class UserListState(IdentityState):
    role: str
    allowed_topics: list[str]
    can_curate: bool


class UserPage(BaseModel):
    items: list[UserListState]
    next_cursor: str | None


class InviteEnvelope(Replayable):
    identity: IdentityState
    membership: MembershipState
    invitation_token: str | None = None
    expires_at: str
    audit_correlation: int


class IdentityMembershipEnvelope(BaseModel):
    identity: IdentityState
    membership: MembershipState
    audit_correlation: int


class PasswordResetEnvelope(Replayable):
    reset_token: str | None = None
    expires_at: str
    audit_correlation: int


class PasswordResetCompleteEnvelope(BaseModel):
    identity: IdentityState
    status: str
    audit_correlation: int


class RevocationState(BaseModel):
    complete: bool
    sessions: str
    pats: str
    oauth: str


class DisableEnvelope(Replayable):
    identity: IdentityState
    revocation: RevocationState
    audit_correlation: int


class CredentialState(BaseModel):
    id: str
    user_id: str
    project: str
    kind: str
    name: str | None
    status: str
    version: int


class CredentialList(BaseModel):
    items: list[CredentialState]


class CredentialEnvelope(Replayable):
    credential: CredentialState
    secret: str | None = None
    audit_correlation: int


class MembershipList(BaseModel):
    memberships: list[MembershipState]


class MembershipEnvelope(Replayable):
    membership: MembershipState
    audit_correlation: int


class MembershipTransition(Replayable):
    before: MembershipState
    after: MembershipState
    audit_correlation: int


class TopicState(BaseModel):
    id: str
    slug: str
    name: str
    sensitivity: int
    hard_window_days: int | None
    status: str
    version: int


class TopicList(BaseModel):
    topics: list[TopicState]


class TopicEnvelope(Replayable):
    topic: TopicState
    topic_id: str
    slug: str
    granted_topics: list[str]
    audit_correlation: int


class TopicTransition(Replayable):
    before: TopicState
    after: TopicState
    audit_correlation: int


class ManagementProblem(BaseModel):
    """Typed union envelope for safe management refusals and conflicts."""

    model_config = ConfigDict(extra="forbid")

    detail: str | None = None
    audit_correlation: int | None = None
    current: dict[str, object] | None = None
    dependencies: dict[str, int] | None = None
    can_delete: bool | None = None
    confirmation: str | None = None
    reason: str | None = None
    retry_after: int | None = None


_COMMON_PROBLEMS: dict[int | str, dict[str, object]] = {
    400: {"model": ManagementProblem, "description": "Invalid management command"},
    401: {"model": ManagementProblem, "description": "Authentication required"},
    403: {"model": ManagementProblem, "description": "Insufficient authority"},
    404: {"model": ManagementProblem, "description": "Not found or concealed"},
    409: {"model": ManagementProblem, "description": "Version or command conflict"},
}
router = APIRouter(prefix="/api/v1/admin", tags=["admin-management"], responses=_COMMON_PROBLEMS)
auth_router = APIRouter(
    prefix="/api/v1/auth",
    tags=["console-auth"],
    responses={400: {"model": ManagementProblem, "description": "Invalid or expired command"}},
)


@dataclass(frozen=True, slots=True)
class Actor:
    user_id: str
    platform_role: str
    session_user: SessionUser | None
    token_scope: ProjectScope | None
    memberships: tuple[tuple[str, str, models.ProjectMembership], ...]

    @property
    def platform_scope(self) -> PlatformIdentityScope:
        return PlatformIdentityScope(
            principal_id=self.user_id,
            principal_type=PrincipalType.HUMAN,
            platform_role=self.platform_role,
        )


def _sm(request: Request) -> async_sessionmaker[AsyncSession]:
    value: async_sessionmaker[AsyncSession] = request.app.state.deps.sessionmaker
    return value


def _token(request: Request) -> str | None:
    value = request.headers.get("Authorization", "")
    prefix = "Bearer "
    return value[len(prefix) :] if value.startswith(prefix) else None


async def _actor(request: Request) -> Actor:
    token = _token(request)
    if token is None:
        raise HTTPException(status_code=401, detail="missing bearer token")
    sm = _sm(request)
    token_scope = await resolve_scope(sm, token)
    session_user = await resolve_session(sm, token)
    if token_scope is None and session_user is None:
        raise HTTPException(status_code=401, detail="invalid token")
    if token_scope is not None:
        user_id = token_scope.principal_id
    elif session_user is not None:
        user_id = session_user.user_id
    else:  # pragma: no cover - guarded by the authentication branch above
        raise HTTPException(status_code=401, detail="invalid token")
    async with sm() as session:
        user = await session.get(models.User, uuid.UUID(user_id))
        if user is None or user.status != "active":
            raise HTTPException(status_code=401, detail="invalid token")
        rows = (
            await session.execute(
                select(models.Project.id, models.Project.slug, models.ProjectMembership)
                .join(
                    models.ProjectMembership,
                    models.ProjectMembership.project_id == models.Project.id,
                )
                .where(models.ProjectMembership.user_id == user.id)
                .order_by(models.Project.slug)
            )
        ).all()
    return Actor(
        user_id=user_id,
        platform_role=user.role,
        session_user=session_user,
        token_scope=token_scope,
        memberships=tuple((str(pid), slug, membership) for pid, slug, membership in rows),
    )


def _scope(
    actor: Actor, project_id: str, membership: models.ProjectMembership | None = None
) -> ProjectScope:
    return Principal(
        id=actor.user_id,
        type=PrincipalType.HUMAN,
        allowed_topics=frozenset(membership.allowed_topics if membership is not None else ()),
        can_curate=membership.can_curate if membership is not None else False,
        role=membership.role if membership is not None else "member",
        platform_role=actor.platform_role,
    ).scope_for(project_id)


async def _audit(
    request: Request,
    actor: Actor,
    project_id: str,
    action: str,
    *,
    denied: bool = False,
    membership: models.ProjectMembership | None = None,
) -> int:
    return await audit_mod.record_audit(
        _sm(request),
        _scope(actor, project_id, membership),
        action=action,
        tool="console",
        denied=denied,
    )


async def _audit_in_session(
    session: AsyncSession,
    actor: Actor,
    project_id: str,
    action: str,
    *,
    denied: bool = False,
    membership: models.ProjectMembership | None = None,
) -> int:
    return await audit_mod.record_audit_in_session(
        session,
        _scope(actor, project_id, membership),
        action=action,
        tool="console",
        denied=denied,
    )


async def _denied(
    request: Request,
    actor: Actor,
    *,
    project_id: str,
    action: str,
    status_code: int,
    detail: str,
) -> JSONResponse:
    correlation = await _audit(request, actor, project_id, action, denied=True)
    return JSONResponse(
        status_code=status_code,
        content={"detail": detail, "audit_correlation": correlation},
    )


async def _project_for_slug(request: Request, slug: str) -> tuple[str, models.Project] | None:
    async with _sm(request)() as session:
        project = await session.scalar(select(models.Project).where(models.Project.slug == slug))
    return (str(project.id), project) if project is not None else None


async def _content_scope(
    request: Request,
    actor: Actor,
    project_slug: str | None,
    *,
    target_action: str,
    capability: Capability,
    local_denied_action: str | None = None,
) -> tuple[ProjectScope, models.ProjectMembership] | JSONResponse:
    requested = project_slug
    if requested is None and actor.token_scope is not None:
        requested = next(
            (slug for pid, slug, _ in actor.memberships if pid == actor.token_scope.project_id),
            None,
        )
    if requested is None and len(actor.memberships) == 1:
        requested = actor.memberships[0][1]
    found = await _project_for_slug(request, requested) if requested is not None else None
    membership_tuple = next(
        (
            (pid, slug, membership)
            for pid, slug, membership in actor.memberships
            if slug == requested
        ),
        None,
    )
    if found is not None and membership_tuple is not None:
        pid, _, membership = membership_tuple
        scope = _scope(actor, pid, membership)
        if membership.status == "active" and isinstance(decide(scope, capability), Allow):
            return scope, membership
        return await _denied(
            request,
            actor,
            project_id=pid,
            action=local_denied_action or target_action,
            status_code=403,
            detail="forbidden",
        )

    # A caller already bound to another project gets a generic absence audit in its own scope;
    # neither the requested tenant nor an object identifier is copied to the trail.
    if actor.memberships:
        own_pid, _, _ = actor.memberships[0]
        generic = target_action.split(" target=", 1)[0] + " denied"
        return await _denied(
            request,
            actor,
            project_id=own_pid,
            action=generic,
            status_code=404,
            detail="not found",
        )
    if found is not None:
        target_pid, _ = found
        return await _denied(
            request,
            actor,
            project_id=target_pid,
            action=target_action,
            status_code=404,
            detail="not found",
        )
    raise HTTPException(status_code=404, detail="not found")


async def _platform_owner(
    request: Request,
    actor: Actor,
    *,
    action: str,
    capability: Capability,
) -> JSONResponse | None:
    if isinstance(decide(actor.platform_scope, capability), Allow):
        return None
    if actor.memberships:
        project_id, _, _ = actor.memberships[0]
        return await _denied(
            request,
            actor,
            project_id=project_id,
            action=action,
            status_code=403,
            detail="forbidden",
        )
    raise HTTPException(status_code=403, detail="forbidden")


def _project_view(project: models.Project) -> dict[str, object]:
    return {
        "id": str(project.id),
        "slug": project.slug,
        "name": project.name,
        "settings": dict(project.settings),
        "status": project.status,
        "version": project.version,
    }


def _membership_view(membership: models.ProjectMembership) -> dict[str, object]:
    return {
        "id": str(membership.id),
        "user_id": str(membership.user_id),
        "role": membership.role,
        "allowed_topics": list(membership.allowed_topics),
        "can_curate": membership.can_curate,
        "status": membership.status,
        "version": membership.version,
    }


def _topic_view(topic: models.Topic) -> dict[str, object]:
    return {
        "id": str(topic.id),
        "slug": topic.slug,
        "name": topic.name,
        "sensitivity": topic.sensitivity,
        "hard_window_days": topic.hard_window_days,
        "status": topic.status,
        "version": topic.version,
    }


def _identity_view(user: models.User) -> dict[str, object]:
    return {"id": str(user.id), "email": user.email, "status": user.status, "version": user.version}


def _credential_view(
    credential: models.PersonalAccessToken, *, user_id: str, project_slug: str
) -> dict[str, object]:
    return {
        "id": str(credential.id),
        "user_id": user_id,
        "project": project_slug,
        "kind": "pat",
        "name": credential.name,
        "status": credential.status,
        "version": credential.version,
    }


def _require_key(value: str | None) -> str:
    # Existing API clients predate the replay contract. Keep their one-shot command working while
    # assigning a server-only nonce; clients that need retry safety send the explicit stable key.
    return value or f"legacy-{uuid.uuid4()}"


async def _replay(
    request: Request,
    actor: Actor,
    operation: str,
    key: str,
    body: dict[str, object],
) -> JSONResponse | None:
    try:
        prior = await commands.replay(
            _sm(request),
            principal_id=actor.user_id,
            operation=operation,
            idempotency_key=key,
            request=body,
        )
    except commands.IdempotencyMismatch as exc:
        correlation = await _audit(request, actor, exc.project_id, operation, denied=True)
        return JSONResponse(
            status_code=409,
            content={"detail": str(exc), "audit_correlation": correlation},
        )
    return JSONResponse(status_code=200, content=prior) if prior is not None else None


async def _locked_replay(
    session: AsyncSession,
    actor: Actor,
    operation: str,
    key: str,
    body: dict[str, object],
) -> JSONResponse | None:
    try:
        prior = await commands.locked_replay(
            session,
            principal_id=actor.user_id,
            operation=operation,
            idempotency_key=key,
            request=body,
        )
    except commands.IdempotencyMismatch as exc:
        correlation = await _audit_in_session(
            session, actor, exc.project_id, operation, denied=True
        )
        return JSONResponse(
            status_code=409,
            content={"detail": str(exc), "audit_correlation": correlation},
        )
    return JSONResponse(status_code=200, content=prior) if prior is not None else None


async def _remember(
    request: Request,
    actor: Actor,
    *,
    project_id: str,
    operation: str,
    key: str,
    body: dict[str, object],
    safe_response: dict[str, object],
    audit_id: int,
) -> None:
    await commands.remember(
        _sm(request),
        project_id=project_id,
        principal_id=actor.user_id,
        operation=operation,
        idempotency_key=key,
        request=body,
        response=safe_response,
        audit_id=audit_id,
    )


def _remember_in_session(
    session: AsyncSession,
    actor: Actor,
    *,
    project_id: str,
    operation: str,
    key: str,
    body: dict[str, object],
    safe_response: dict[str, object],
    audit_id: int,
    status: str = "completed",
) -> None:
    commands.remember_in_session(
        session,
        project_id=project_id,
        principal_id=actor.user_id,
        operation=operation,
        idempotency_key=key,
        request=body,
        response=safe_response,
        audit_id=audit_id,
        status=status,
    )


# --- platform project lifecycle -------------------------------------------


async def _project_owner_access(
    request: Request,
    actor: Actor,
    slug: str,
    *,
    action: str,
    capability: Capability,
) -> tuple[str, models.Project] | JSONResponse:
    found = await _project_for_slug(request, slug)
    if found is None:
        raise HTTPException(status_code=404, detail="not found")
    if isinstance(decide(actor.platform_scope, capability), Allow):
        return found
    own = next((item for item in actor.memberships if item[1] == slug), None)
    if own is None and actor.memberships:
        own_pid, _, _ = actor.memberships[0]
        generic = action.split(" target=", 1)[0] + " denied"
        return await _denied(
            request,
            actor,
            project_id=own_pid,
            action=generic,
            status_code=404,
            detail="not found",
        )
    project_id, _ = found
    return await _denied(
        request,
        actor,
        project_id=project_id,
        action=action,
        status_code=403,
        detail="forbidden",
    )


@router.get("/projects", response_model=ProjectInventory)
async def list_projects(request: Request) -> Any:
    actor = await _actor(request)
    denial = await _platform_owner(
        request,
        actor,
        action="project:list target=global",
        capability=Capability.PLATFORM_PROJECT_LIST_ALL,
    )
    if denial is not None:
        return denial
    async with _sm(request)() as session:
        rows = (
            await session.execute(
                select(models.Project, func.count(models.ProjectMembership.id))
                .outerjoin(
                    models.ProjectMembership,
                    models.ProjectMembership.project_id == models.Project.id,
                )
                .group_by(models.Project.id)
                .order_by(models.Project.slug)
            )
        ).all()
    return {
        "projects": [
            {**_project_view(project), "membership_count": membership_count}
            for project, membership_count in rows
        ]
    }


@router.get("/projects/{slug}", response_model=ProjectState)
async def read_project(slug: str, request: Request) -> Any:
    actor = await _actor(request)
    access = await _project_owner_access(
        request,
        actor,
        slug,
        action=f"project:read target={slug}",
        capability=Capability.PLATFORM_PROJECT_LIST_ALL,
    )
    if isinstance(access, JSONResponse):
        return access
    _, project = access
    return _project_view(project)


@router.post(
    "/projects",
    status_code=status.HTTP_201_CREATED,
    response_model=ProjectEnvelope,
    response_model_exclude_unset=True,
    responses={429: {"model": ManagementProblem, "description": "Management rate limit"}},
)
async def create_project(
    body: ProjectCreate,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> Any:
    actor = await _actor(request)
    action = f"project:create target={body.slug}"
    denial = await _platform_owner(
        request, actor, action=action, capability=Capability.PLATFORM_PROJECT_CREATE
    )
    if denial is not None:
        return denial
    key = _require_key(idempotency_key)
    request_body = body.model_dump()
    prior = await _replay(request, actor, action, key, request_body)
    if prior is not None:
        return prior
    async with _sm(request)() as session:
        default_id = await session.scalar(
            select(models.Project.id).where(models.Project.slug == "default")
        )
        if default_id is None:
            default_id = await session.scalar(
                select(models.Project.id).order_by(models.Project.slug)
            )
    if default_id is None:
        raise HTTPException(status_code=409, detail="a default audit scope is required")
    injected = request.app.state.deps.management_limiter
    limiter: Any = injected or QuotaService(_sm(request))
    async with session_scope(_sm(request)) as session:
        locked = await _locked_replay(session, actor, action, key, request_body)
        if locked is not None:
            return locked
        await commands.lock_resource(session, f"project:{body.slug}")
        existing = await session.scalar(
            select(models.Project).where(models.Project.slug == body.slug)
        )
        if existing is not None:
            correlation = await _audit_in_session(
                session, actor, str(default_id), action, denied=True
            )
            return JSONResponse(
                status_code=409,
                content={"current": _project_view(existing), "audit_correlation": correlation},
            )
        try:
            await limiter.consume(
                _scope(actor, str(default_id)),
                "project:create" if injected is not None else "write",
            )
        except RateLimitedError as limited:
            correlation = await _audit_in_session(
                session, actor, str(default_id), action, denied=True
            )
            return JSONResponse(
                status_code=429,
                headers={"Retry-After": str(limited.retry_after)},
                content={
                    "detail": "rate limit exceeded",
                    "retry_after": limited.retry_after,
                    "audit_correlation": correlation,
                },
            )
        project = models.Project(
            slug=body.slug,
            name=body.name,
            settings=body.settings,
            status="active",
            version=1,
        )
        session.add(project)
        await session.flush()
        project_state = _project_view(project)
        project_id = str(project.id)
        correlation = await _audit_in_session(session, actor, project_id, action)
        safe = {"project": project_state, "audit_correlation": correlation}
        _remember_in_session(
            session,
            actor,
            project_id=project_id,
            operation=action,
            key=key,
            body=request_body,
            safe_response=safe,
            audit_id=correlation,
        )
    return safe


@router.patch(
    "/projects/{slug}",
    response_model=ProjectTransition,
    response_model_exclude_unset=True,
)
async def update_project(
    slug: str,
    body: ProjectUpdate,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> Any:
    actor = await _actor(request)
    action = f"project:update target={slug}"
    access = await _project_owner_access(
        request,
        actor,
        slug,
        action=action,
        capability=Capability.PLATFORM_PROJECT_CREATE,
    )
    if isinstance(access, JSONResponse):
        return access
    project_id, _ = access
    key = _require_key(idempotency_key)
    request_body = body.model_dump(exclude_none=True)
    prior = await _replay(request, actor, action, key, request_body)
    if prior is not None:
        return prior
    async with session_scope(_sm(request)) as session:
        locked = await _locked_replay(session, actor, action, key, request_body)
        if locked is not None:
            return locked
        project = await session.scalar(
            select(models.Project)
            .where(models.Project.id == uuid.UUID(project_id))
            .with_for_update()
        )
        if project is None:
            raise HTTPException(status_code=404, detail="not found")
        current = _project_view(project)
        if project.status != "active" or project.version != body.expected_version:
            correlation = await _audit_in_session(session, actor, project_id, action, denied=True)
            return JSONResponse(
                status_code=409,
                content={"current": current, "audit_correlation": correlation},
            )
        before = current
        if body.name is not None:
            project.name = body.name
        if body.settings is not None:
            project.settings = body.settings
        project.version += 1
        await session.flush()
        after = _project_view(project)
        correlation = await _audit_in_session(session, actor, project_id, action)
        safe = {"before": before, "after": after, "audit_correlation": correlation}
        _remember_in_session(
            session,
            actor,
            project_id=project_id,
            operation=action,
            key=key,
            body=request_body,
            safe_response=safe,
            audit_id=correlation,
        )
    return safe


async def _project_dependencies(request: Request, project_id: str) -> dict[str, int]:
    pid = uuid.UUID(project_id)
    async with _sm(request)() as session:

        async def count(model: Any) -> int:
            return int(
                await session.scalar(
                    select(func.count()).select_from(model).where(model.project_id == pid)
                )
                or 0
            )

        credentials = int(
            await session.scalar(
                select(func.count())
                .select_from(models.PersonalAccessToken)
                .join(
                    models.ProjectMembership,
                    models.PersonalAccessToken.membership_id == models.ProjectMembership.id,
                )
                .where(models.ProjectMembership.project_id == pid)
            )
            or 0
        )
        return {
            "topics": await count(models.Topic),
            "memberships": await count(models.ProjectMembership),
            "credentials": credentials,
            "documents": await count(models.Document),
            "claims": await count(models.Claim),
            "hunts": await count(models.Hunt),
            "skills": await count(models.Skill),
        }


@router.get("/projects/{slug}/delete-impact", response_model=ProjectImpact)
async def project_delete_impact(slug: str, request: Request) -> Any:
    actor = await _actor(request)
    action = f"project:delete-impact target={slug}"
    access = await _project_owner_access(
        request,
        actor,
        slug,
        action=action,
        capability=Capability.PLATFORM_PROJECT_LIST_ALL,
    )
    if isinstance(access, JSONResponse):
        return access
    project_id, project = access
    return {
        "project": _project_view(project),
        "version": project.version,
        "dependencies": await _project_dependencies(request, project_id),
        "can_delete": slug != "default",
        "confirmation": slug,
    }


@router.delete(
    "/projects/{slug}",
    response_model=ProjectDeleteEnvelope,
    response_model_exclude_unset=True,
)
async def delete_project(
    slug: str,
    request: Request,
    expected_version: int = Query(ge=1),
    confirm: str = Query(),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> Any:
    actor = await _actor(request)
    action = f"project:delete target={slug}"
    key = _require_key(idempotency_key)
    request_body: dict[str, object] = {"expected_version": expected_version, "confirm": confirm}
    prior = await _replay(request, actor, action, key, request_body)
    if prior is not None:
        return prior
    from rsc_brain.knowledge.gdpr import hard_delete_project

    try:
        async with commands.serialized_command(
            _sm(request),
            operation=action,
        ) as coordination:
            command = await commands.read_command(
                coordination,
                principal_id=actor.user_id,
                operation=action,
                idempotency_key=key,
                request=request_body,
            )
            if command is not None and command.status == "completed":
                return JSONResponse(status_code=200, content={**command.response, "replayed": True})
            if command is not None:
                denial = await _platform_owner(
                    request,
                    actor,
                    action=action,
                    capability=Capability.PLATFORM_PROJECT_CREATE,
                )
                if denial is not None:
                    return denial
                project_id = command.project_id
                safe = command.response
                resumed = True
            else:
                access = await _project_owner_access(
                    request,
                    actor,
                    slug,
                    action=action,
                    capability=Capability.PLATFORM_PROJECT_CREATE,
                )
                if isinstance(access, JSONResponse):
                    return access
                project_id, project = access
                current = _project_view(project)
                dependencies = await _project_dependencies(request, project_id)
                if slug == "default":
                    correlation = await _audit(request, actor, project_id, action, denied=True)
                    return JSONResponse(
                        status_code=409,
                        content={
                            "current": current,
                            "dependencies": dependencies,
                            "can_delete": False,
                            "confirmation": "default",
                            "reason": "protected_default",
                            "audit_correlation": correlation,
                        },
                    )
                if project.version != expected_version or confirm != slug:
                    correlation = await _audit(request, actor, project_id, action, denied=True)
                    return JSONResponse(
                        status_code=409,
                        content={"current": current, "audit_correlation": correlation},
                    )
                async with session_scope(_sm(request)) as session:
                    locked_project = await session.scalar(
                        select(models.Project)
                        .where(models.Project.id == uuid.UUID(project_id))
                        .with_for_update()
                    )
                    if (
                        locked_project is None
                        or locked_project.status != "active"
                        or locked_project.version != expected_version
                    ):
                        raise HTTPException(status_code=409, detail="project changed; refetch")
                    locked_project.status = "deleting"
                    locked_project.version += 1
                    correlation = await _audit_in_session(session, actor, project_id, action)
                    safe = {
                        "project": slug,
                        "status": "deleted",
                        "audit_correlation": correlation,
                    }
                    _remember_in_session(
                        session,
                        actor,
                        project_id=project_id,
                        operation=action,
                        key=key,
                        body=request_body,
                        safe_response=safe,
                        audit_id=correlation,
                        status="pending",
                    )
                resumed = False

            await hard_delete_project(
                _sm(request),
                _scope(actor, project_id),
                data_dir=request.app.state.deps.data_dir,
            )
            await commands.mark_completed(
                _sm(request),
                principal_id=actor.user_id,
                operation=action,
                idempotency_key=key,
            )
            return {**safe, **({"replayed": True} if resumed else {})}
    except commands.IdempotencyMismatch as exc:
        correlation = await _audit(request, actor, exc.project_id, action, denied=True)
        return JSONResponse(
            status_code=409,
            content={"detail": str(exc), "audit_correlation": correlation},
        )


# --- project identities ----------------------------------------------------


@router.get("/users", response_model=UserPage)
async def list_users(
    request: Request,
    project: str | None = None,
    limit: int = Query(default=100, ge=1, le=200),
    cursor: str | None = None,
) -> Any:
    actor = await _actor(request)
    action = f"identity:list target={project or 'current'}"
    authorized = await _content_scope(
        request,
        actor,
        project,
        target_action=action,
        capability=Capability.PROJECT_MANAGE_READ,
    )
    if isinstance(authorized, JSONResponse):
        return authorized
    scope, _ = authorized
    page_conditions: list[object] = [
        models.ProjectMembership.project_id == uuid.UUID(scope.project_id)
    ]
    if cursor is not None:
        try:
            last_email, last_id = commands.decode_user_cursor(
                _sm(request),
                principal_id=actor.user_id,
                project_id=scope.project_id,
                value=cursor,
            )
        except commands.InvalidUserCursor as exc:
            raise HTTPException(status_code=400, detail="invalid cursor") from exc
        page_conditions.append(
            or_(
                models.User.email > last_email,
                and_(models.User.email == last_email, models.User.id > last_id),
            )
        )
    async with _sm(request)() as session:
        rows = (
            await session.execute(
                select(models.User, models.ProjectMembership)
                .join(
                    models.ProjectMembership,
                    models.ProjectMembership.user_id == models.User.id,
                )
                .where(*page_conditions)  # type: ignore[arg-type]
                .order_by(models.User.email, models.User.id)
                .limit(limit + 1)
            )
        ).all()
    page = rows[:limit]
    return {
        "items": [
            {
                **_identity_view(user),
                "role": membership.role,
                "allowed_topics": list(membership.allowed_topics),
                "can_curate": membership.can_curate,
            }
            for user, membership in page
        ],
        "next_cursor": (
            commands.encode_user_cursor(
                _sm(request),
                principal_id=actor.user_id,
                project_id=scope.project_id,
                email=page[-1][0].email,
                user_id=str(page[-1][0].id),
            )
            if len(rows) > limit and page
            else None
        ),
    }


@router.post(
    "/users/invite",
    status_code=status.HTTP_201_CREATED,
    response_model=InviteEnvelope,
    response_model_exclude_unset=True,
)
async def invite_user(
    body: UserInvite,
    request: Request,
    project: str | None = None,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> Any:
    actor = await _actor(request)
    action = f"identity:invite target={body.email}"
    authorized = await _content_scope(
        request,
        actor,
        project,
        target_action=action,
        capability=Capability.PROJECT_CONFIG_WRITE,
    )
    if isinstance(authorized, JSONResponse):
        return authorized
    scope, _ = authorized
    if body.platform_role not in _PLATFORM_ROLES:
        correlation = await _audit(request, actor, scope.project_id, action, denied=True)
        return JSONResponse(
            status_code=400,
            content={"detail": "unknown platform role", "audit_correlation": correlation},
        )
    if body.project_role not in _PROJECT_ROLES:
        correlation = await _audit(request, actor, scope.project_id, action, denied=True)
        return JSONResponse(
            status_code=400,
            content={"detail": "unknown project role", "audit_correlation": correlation},
        )
    if body.platform_role != "member" and not isinstance(
        decide(actor.platform_scope, Capability.PLATFORM_USER_INVITE), Allow
    ):
        correlation = await _audit(request, actor, scope.project_id, action, denied=True)
        return JSONResponse(
            status_code=403,
            content={"detail": "forbidden", "audit_correlation": correlation},
        )
    unknown = set(body.allowed_topics) - await _known_topics(request, scope.project_id)
    if unknown:
        correlation = await _audit(request, actor, scope.project_id, action, denied=True)
        return JSONResponse(
            status_code=400,
            content={"detail": "unknown topics", "audit_correlation": correlation},
        )
    key = _require_key(idempotency_key)
    request_body = body.model_dump()
    prior = await _replay(request, actor, action, key, request_body)
    if prior is not None:
        return prior
    token = security.mint_token(security.INVITATION_PREFIX)
    expires = dt.datetime.now(dt.UTC) + dt.timedelta(days=7)
    async with session_scope(_sm(request)) as session:
        locked = await _locked_replay(session, actor, action, key, request_body)
        if locked is not None:
            return locked
        await commands.lock_resource(session, f"identity:{body.email}")
        existing = await session.scalar(
            select(models.User.id).where(models.User.email == body.email)
        )
        if existing is not None:
            correlation = await _audit_in_session(
                session, actor, scope.project_id, action, denied=True
            )
            return JSONResponse(
                status_code=409,
                content={"detail": "identity unavailable", "audit_correlation": correlation},
            )
        user = models.User(
            email=body.email,
            role=body.platform_role,
            status="invited",
            version=1,
        )
        session.add(user)
        await session.flush()
        membership = models.ProjectMembership(
            user_id=user.id,
            project_id=uuid.UUID(scope.project_id),
            role=body.project_role,
            allowed_topics=body.allowed_topics,
            can_curate=body.can_curate,
            status="active",
            version=1,
        )
        session.add(membership)
        session.add(
            models.Invitation(
                user_id=user.id,
                token_hash=security.token_hash(token),
                expires_at=expires,
                kind="invitation",
            )
        )
        await session.flush()
        identity_state = _identity_view(user)
        membership_state = _membership_view(membership)
        correlation = await _audit_in_session(session, actor, scope.project_id, action)
        safe = {
            "identity": identity_state,
            "membership": membership_state,
            "expires_at": expires.isoformat(),
            "audit_correlation": correlation,
        }
        _remember_in_session(
            session,
            actor,
            project_id=scope.project_id,
            operation=action,
            key=key,
            body=request_body,
            safe_response=safe,
            audit_id=correlation,
        )
    return {**safe, "invitation_token": token}


async def _invitation_context(
    request: Request, token: str, kind: str
) -> tuple[models.Invitation, models.User, models.ProjectMembership] | None:
    async with _sm(request)() as session:
        invitation = await session.scalar(
            select(models.Invitation).where(
                models.Invitation.token_hash == security.token_hash(token),
                models.Invitation.kind == kind,
            )
        )
        if invitation is None:
            return None
        user = await session.get(models.User, invitation.user_id)
        membership = await session.scalar(
            select(models.ProjectMembership)
            .where(models.ProjectMembership.user_id == invitation.user_id)
            .order_by(models.ProjectMembership.id)
        )
    if user is None or membership is None:
        return None
    return invitation, user, membership


@auth_router.post("/invitations/accept", response_model=IdentityMembershipEnvelope)
async def accept_invitation(body: InvitationAccept, request: Request) -> Any:
    context = await _invitation_context(request, body.token, "invitation")
    now = dt.datetime.now(dt.UTC)
    if (
        context is None
        or context[0].used_at is not None
        or (context[0].expires_at is not None and context[0].expires_at < now)
    ):
        return JSONResponse(status_code=400, content={"detail": "invalid invitation"})
    invitation, user_snapshot, membership_snapshot = context
    target_actor = Actor(
        user_id=str(user_snapshot.id),
        platform_role=user_snapshot.role,
        session_user=None,
        token_scope=None,
        memberships=(),
    )
    action = f"identity:accept target={user_snapshot.id}"
    async with session_scope(_sm(request)) as session:
        current_invitation = await session.scalar(
            select(models.Invitation).where(models.Invitation.id == invitation.id).with_for_update()
        )
        if (
            current_invitation is None
            or current_invitation.used_at is not None
            or (current_invitation.expires_at is not None and current_invitation.expires_at < now)
        ):
            return JSONResponse(status_code=400, content={"detail": "invalid invitation"})
        user = await session.get(models.User, user_snapshot.id)
        membership = await session.get(models.ProjectMembership, membership_snapshot.id)
        if user is None or membership is None:
            return JSONResponse(status_code=400, content={"detail": "invalid invitation"})
        current_invitation.used_at = now
        user.password_hash = security.hash_password(body.password)
        user.status = "active"
        user.version += 1
        await session.flush()
        identity_state = _identity_view(user)
        membership_state = _membership_view(membership)
        project_id = str(membership.project_id)
        correlation = await _audit_in_session(session, target_actor, project_id, action)
    return {
        "identity": identity_state,
        "membership": membership_state,
        "audit_correlation": correlation,
    }


@router.post(
    "/users/{user_id}/password-reset",
    status_code=status.HTTP_201_CREATED,
    response_model=PasswordResetEnvelope,
    response_model_exclude_unset=True,
)
async def request_password_reset(
    user_id: str,
    body: ImpactCommand,
    request: Request,
    project: str | None = None,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> Any:
    actor = await _actor(request)
    action = f"identity:reset target={user_id}"
    authorized = await _content_scope(
        request,
        actor,
        project,
        target_action=action,
        capability=Capability.PROJECT_CONFIG_WRITE,
    )
    if isinstance(authorized, JSONResponse):
        return authorized
    scope, _ = authorized
    key = _require_key(idempotency_key)
    request_body = body.model_dump()
    prior = await _replay(request, actor, action, key, request_body)
    if prior is not None:
        return prior
    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="not found") from None
    token = security.mint_token(security.INVITATION_PREFIX)
    expires = dt.datetime.now(dt.UTC) + dt.timedelta(hours=1)
    async with session_scope(_sm(request)) as session:
        locked = await _locked_replay(session, actor, action, key, request_body)
        if locked is not None:
            return locked
        membership = await session.scalar(
            select(models.ProjectMembership).where(
                models.ProjectMembership.user_id == uid,
                models.ProjectMembership.project_id == uuid.UUID(scope.project_id),
            )
        )
        user = await session.get(models.User, uid)
        if membership is None or user is None or user.status != "active":
            raise HTTPException(status_code=404, detail="not found")
        session.add(
            models.Invitation(
                user_id=uid,
                token_hash=security.token_hash(token),
                expires_at=expires,
                kind="password_reset",
            )
        )
        correlation = await _audit_in_session(session, actor, scope.project_id, action)
        safe = {"expires_at": expires.isoformat(), "audit_correlation": correlation}
        _remember_in_session(
            session,
            actor,
            project_id=scope.project_id,
            operation=action,
            key=key,
            body=request_body,
            safe_response=safe,
            audit_id=correlation,
        )
    return {**safe, "reset_token": token}


@auth_router.post("/password-reset/complete", response_model=PasswordResetCompleteEnvelope)
async def complete_password_reset(body: PasswordResetComplete, request: Request) -> Any:
    context = await _invitation_context(request, body.token, "password_reset")
    now = dt.datetime.now(dt.UTC)
    if (
        context is None
        or context[0].used_at is not None
        or (context[0].expires_at is not None and context[0].expires_at < now)
    ):
        return JSONResponse(status_code=400, content={"detail": "invalid reset token"})
    invitation, user_snapshot, membership_snapshot = context
    target_actor = Actor(
        user_id=str(user_snapshot.id),
        platform_role=user_snapshot.role,
        session_user=None,
        token_scope=None,
        memberships=(),
    )
    action = f"identity:reset-complete target={user_snapshot.id}"
    async with session_scope(_sm(request)) as session:
        current = await session.scalar(
            select(models.Invitation).where(models.Invitation.id == invitation.id).with_for_update()
        )
        if (
            current is None
            or current.used_at is not None
            or (current.expires_at is not None and current.expires_at < now)
        ):
            return JSONResponse(status_code=400, content={"detail": "invalid reset token"})
        user = await session.get(models.User, user_snapshot.id)
        if user is None or user.status != "active":
            return JSONResponse(status_code=400, content={"detail": "invalid reset token"})
        current.used_at = now
        user.password_hash = security.hash_password(body.new_password)
        user.version += 1
        await session.execute(
            update(models.ConsoleSession)
            .where(models.ConsoleSession.user_id == user.id)
            .values(revoked_at=now)
        )
        await session.flush()
        identity_state = _identity_view(user)
        correlation = await _audit_in_session(
            session, target_actor, str(membership_snapshot.project_id), action
        )
    return {"identity": identity_state, "status": "completed", "audit_correlation": correlation}


@router.post(
    "/users/{user_id}/disable",
    response_model=DisableEnvelope,
    response_model_exclude_unset=True,
)
async def disable_user(
    user_id: str,
    body: DisableCommand,
    request: Request,
    project: str | None = None,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> Any:
    actor = await _actor(request)
    action = f"identity:disable target={user_id}"
    authorized = await _content_scope(
        request,
        actor,
        project,
        target_action=action,
        capability=Capability.PROJECT_CONFIG_WRITE,
        local_denied_action="identity:disable denied",
    )
    if isinstance(authorized, JSONResponse):
        return authorized
    scope, _ = authorized
    key = _require_key(idempotency_key)
    request_body = body.model_dump()
    prior = await _replay(request, actor, action, key, request_body)
    if prior is not None:
        return prior
    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="not found") from None
    now = dt.datetime.now(dt.UTC)
    async with session_scope(_sm(request)) as session:
        locked = await _locked_replay(session, actor, action, key, request_body)
        if locked is not None:
            return locked
        membership = await session.scalar(
            select(models.ProjectMembership).where(
                models.ProjectMembership.user_id == uid,
                models.ProjectMembership.project_id == uuid.UUID(scope.project_id),
            )
        )
        user = await session.get(models.User, uid)
        if membership is None or user is None:
            raise HTTPException(status_code=404, detail="not found")
        if user.status != body.expected_status or not body.impact_acknowledged:
            correlation = await _audit_in_session(
                session, actor, scope.project_id, action, denied=True
            )
            return JSONResponse(
                status_code=409,
                content={"current": _identity_view(user), "audit_correlation": correlation},
            )
        memberships = (
            await session.execute(
                select(models.ProjectMembership.id, models.ProjectMembership.project_id).where(
                    models.ProjectMembership.user_id == uid
                )
            )
        ).all()
        if any(str(row.project_id) != scope.project_id for row in memberships) and not isinstance(
            decide(actor.platform_scope, Capability.PLATFORM_USER_INVITE), Allow
        ):
            correlation = await _audit_in_session(
                session, actor, scope.project_id, action, denied=True
            )
            return JSONResponse(
                status_code=403,
                content={"detail": "forbidden", "audit_correlation": correlation},
            )
        user.status = "disabled"
        user.version += 1
        membership_ids = [row.id for row in memberships]
        if membership_ids:
            await session.execute(
                update(models.PersonalAccessToken)
                .where(models.PersonalAccessToken.membership_id.in_(membership_ids))
                .values(
                    revoked_at=now,
                    status="revoked",
                    version=models.PersonalAccessToken.version + 1,
                )
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
        await session.flush()
        identity_state = _identity_view(user)
        correlation = await _audit_in_session(session, actor, scope.project_id, action)
        safe = {
            "identity": identity_state,
            "revocation": {
                "complete": True,
                "sessions": "revoked",
                "pats": "revoked",
                "oauth": "revoked",
            },
            "audit_correlation": correlation,
        }
        _remember_in_session(
            session,
            actor,
            project_id=scope.project_id,
            operation=action,
            key=key,
            body=request_body,
            safe_response=safe,
            audit_id=correlation,
        )
    return safe


# --- third-party credentials ----------------------------------------------


async def _credential_target(
    request: Request, project_id: str, credential_id: str
) -> tuple[models.PersonalAccessToken, str, str] | None:
    try:
        cid = uuid.UUID(credential_id)
    except ValueError:
        return None
    async with _sm(request)() as session:
        row = (
            await session.execute(
                select(
                    models.PersonalAccessToken,
                    models.ProjectMembership.user_id,
                    models.Project.slug,
                )
                .join(
                    models.ProjectMembership,
                    models.PersonalAccessToken.membership_id == models.ProjectMembership.id,
                )
                .join(models.Project, models.ProjectMembership.project_id == models.Project.id)
                .where(
                    models.PersonalAccessToken.id == cid,
                    models.ProjectMembership.project_id == uuid.UUID(project_id),
                )
            )
        ).first()
    if row is None:
        return None
    credential, user_id, slug = row
    return credential, str(user_id), slug


@router.get("/users/{user_id}/credentials", response_model=CredentialList)
async def list_credentials(user_id: str, request: Request, project: str | None = None) -> Any:
    actor = await _actor(request)
    action = f"credential:list target={user_id}"
    authorized = await _content_scope(
        request,
        actor,
        project,
        target_action=action,
        capability=Capability.PROJECT_MANAGE_READ,
    )
    if isinstance(authorized, JSONResponse):
        return authorized
    scope, _ = authorized
    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="not found") from None
    async with _sm(request)() as session:
        target_membership = await session.scalar(
            select(models.ProjectMembership).where(
                models.ProjectMembership.user_id == uid,
                models.ProjectMembership.project_id == uuid.UUID(scope.project_id),
            )
        )
        if target_membership is None:
            raise HTTPException(status_code=404, detail="not found")
        project_slug = await session.scalar(
            select(models.Project.slug).where(models.Project.id == uuid.UUID(scope.project_id))
        )
        rows = (
            await session.scalars(
                select(models.PersonalAccessToken)
                .where(models.PersonalAccessToken.membership_id == target_membership.id)
                .order_by(models.PersonalAccessToken.created_at, models.PersonalAccessToken.id)
            )
        ).all()
    return {
        "items": [
            _credential_view(row, user_id=user_id, project_slug=str(project_slug)) for row in rows
        ]
    }


@router.post(
    "/users/{user_id}/credentials",
    status_code=status.HTTP_201_CREATED,
    response_model=CredentialEnvelope,
    response_model_exclude_unset=True,
)
async def create_credential(
    user_id: str,
    body: CredentialCreate,
    request: Request,
    project: str | None = None,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> Any:
    actor = await _actor(request)
    action_prefix = f"credential:create target={user_id}"
    authorized = await _content_scope(
        request,
        actor,
        project,
        target_action=action_prefix,
        capability=Capability.PROJECT_CONFIG_WRITE,
    )
    if isinstance(authorized, JSONResponse):
        return authorized
    scope, _ = authorized
    if body.kind != "pat":
        raise HTTPException(status_code=400, detail="unsupported credential kind")
    key = _require_key(idempotency_key)
    request_body = body.model_dump()
    # The final audit action is keyed by the server UUID, while replay lookup must happen before a
    # new UUID exists. The command namespace therefore uses the target user and stores that result.
    operation = action_prefix
    prior = await _replay(request, actor, operation, key, request_body)
    if prior is not None:
        return prior
    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="not found") from None
    secret = security.mint_token(security.PAT_PREFIX)
    async with session_scope(_sm(request)) as session:
        locked = await _locked_replay(session, actor, operation, key, request_body)
        if locked is not None:
            return locked
        membership = await session.scalar(
            select(models.ProjectMembership).where(
                models.ProjectMembership.user_id == uid,
                models.ProjectMembership.project_id == uuid.UUID(scope.project_id),
            )
        )
        user = await session.get(models.User, uid)
        project_slug = await session.scalar(
            select(models.Project.slug).where(models.Project.id == uuid.UUID(scope.project_id))
        )
        if membership is None or user is None or user.status != "active" or project_slug is None:
            raise HTTPException(status_code=404, detail="not found")
        credential = models.PersonalAccessToken(
            membership_id=membership.id,
            token_hash=security.token_hash(secret),
            name=body.name,
            status="active",
            version=1,
        )
        session.add(credential)
        await session.flush()
        metadata = _credential_view(credential, user_id=user_id, project_slug=project_slug)
        credential_id = str(credential.id)
        action = f"credential:create target={credential_id}"
        correlation = await _audit_in_session(session, actor, scope.project_id, action)
        safe = {"credential": metadata, "audit_correlation": correlation}
        _remember_in_session(
            session,
            actor,
            project_id=scope.project_id,
            operation=operation,
            key=key,
            body=request_body,
            safe_response=safe,
            audit_id=correlation,
        )
    return {**safe, "secret": secret}


@router.post(
    "/credentials/{credential_id}/rotate",
    status_code=status.HTTP_201_CREATED,
    response_model=CredentialEnvelope,
    response_model_exclude_unset=True,
)
async def rotate_credential(
    credential_id: str,
    body: VersionedCommand,
    request: Request,
    project: str | None = None,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> Any:
    actor = await _actor(request)
    action = f"credential:rotate target={credential_id}"
    authorized = await _content_scope(
        request,
        actor,
        project,
        target_action=action,
        capability=Capability.PROJECT_CONFIG_WRITE,
    )
    if isinstance(authorized, JSONResponse):
        return authorized
    scope, _ = authorized
    key = _require_key(idempotency_key)
    request_body = body.model_dump()
    prior = await _replay(request, actor, action, key, request_body)
    if prior is not None:
        return prior
    found = await _credential_target(request, scope.project_id, credential_id)
    if found is None:
        raise HTTPException(status_code=404, detail="not found")
    credential_snapshot, user_id, project_slug = found
    current = _credential_view(credential_snapshot, user_id=user_id, project_slug=project_slug)
    if credential_snapshot.version != body.expected_version:
        correlation = await _audit(request, actor, scope.project_id, action, denied=True)
        return JSONResponse(
            status_code=409,
            content={"current": current, "audit_correlation": correlation},
        )
    secret = security.mint_token(security.PAT_PREFIX)
    async with session_scope(_sm(request)) as session:
        locked = await _locked_replay(session, actor, action, key, request_body)
        if locked is not None:
            return locked
        credential = await session.scalar(
            select(models.PersonalAccessToken)
            .where(models.PersonalAccessToken.id == credential_snapshot.id)
            .with_for_update()
        )
        if credential is None:
            raise HTTPException(status_code=404, detail="not found")
        if credential.version != body.expected_version:
            latest = _credential_view(credential, user_id=user_id, project_slug=project_slug)
            correlation = await _audit_in_session(
                session, actor, scope.project_id, action, denied=True
            )
            return JSONResponse(
                status_code=409,
                content={"current": latest, "audit_correlation": correlation},
            )
        credential.token_hash = security.token_hash(secret)
        credential.revoked_at = None
        credential.status = "active"
        credential.version += 1
        await session.flush()
        metadata = _credential_view(credential, user_id=user_id, project_slug=project_slug)
        correlation = await _audit_in_session(session, actor, scope.project_id, action)
        safe = {"credential": metadata, "audit_correlation": correlation}
        _remember_in_session(
            session,
            actor,
            project_id=scope.project_id,
            operation=action,
            key=key,
            body=request_body,
            safe_response=safe,
            audit_id=correlation,
        )
    return {**safe, "secret": secret}


@router.delete(
    "/credentials/{credential_id}",
    response_model=CredentialEnvelope,
    response_model_exclude_unset=True,
)
async def revoke_credential(
    credential_id: str,
    request: Request,
    expected_version: int = Query(ge=1),
    project: str | None = None,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> Any:
    actor = await _actor(request)
    action = f"credential:revoke target={credential_id}"
    if project is None:
        try:
            cid = uuid.UUID(credential_id)
        except ValueError:
            cid = None
        if cid is not None:
            async with _sm(request)() as session:
                project = await session.scalar(
                    select(models.Project.slug)
                    .join(
                        models.ProjectMembership,
                        models.ProjectMembership.project_id == models.Project.id,
                    )
                    .join(
                        models.PersonalAccessToken,
                        models.PersonalAccessToken.membership_id == models.ProjectMembership.id,
                    )
                    .where(models.PersonalAccessToken.id == cid)
                )
    authorized = await _content_scope(
        request,
        actor,
        project,
        target_action=action,
        capability=Capability.PROJECT_CONFIG_WRITE,
    )
    if isinstance(authorized, JSONResponse):
        return authorized
    scope, _ = authorized
    key = _require_key(idempotency_key)
    request_body: dict[str, object] = {"expected_version": expected_version}
    prior = await _replay(request, actor, action, key, request_body)
    if prior is not None:
        return prior
    found = await _credential_target(request, scope.project_id, credential_id)
    if found is None:
        raise HTTPException(status_code=404, detail="not found")
    credential_snapshot, user_id, project_slug = found
    current = _credential_view(credential_snapshot, user_id=user_id, project_slug=project_slug)
    if credential_snapshot.version != expected_version:
        correlation = await _audit(request, actor, scope.project_id, action, denied=True)
        return JSONResponse(
            status_code=409,
            content={"current": current, "audit_correlation": correlation},
        )
    async with session_scope(_sm(request)) as session:
        locked = await _locked_replay(session, actor, action, key, request_body)
        if locked is not None:
            return locked
        credential = await session.scalar(
            select(models.PersonalAccessToken)
            .where(models.PersonalAccessToken.id == credential_snapshot.id)
            .with_for_update()
        )
        if credential is None:
            raise HTTPException(status_code=404, detail="not found")
        if credential.version != expected_version:
            latest = _credential_view(credential, user_id=user_id, project_slug=project_slug)
            correlation = await _audit_in_session(
                session, actor, scope.project_id, action, denied=True
            )
            return JSONResponse(
                status_code=409,
                content={"current": latest, "audit_correlation": correlation},
            )
        credential.revoked_at = dt.datetime.now(dt.UTC)
        credential.status = "revoked"
        credential.version += 1
        await session.flush()
        metadata = _credential_view(credential, user_id=user_id, project_slug=project_slug)
        correlation = await _audit_in_session(session, actor, scope.project_id, action)
        safe = {"credential": metadata, "audit_correlation": correlation}
        _remember_in_session(
            session,
            actor,
            project_id=scope.project_id,
            operation=action,
            key=key,
            body=request_body,
            safe_response=safe,
            audit_id=correlation,
        )
    return safe


# --- memberships and topics -----------------------------------------------


@router.get("/memberships", response_model=MembershipList)
async def list_memberships(request: Request, project: str | None = None) -> Any:
    actor = await _actor(request)
    action = f"membership:list target={project or 'current'}"
    authorized = await _content_scope(
        request,
        actor,
        project,
        target_action=action,
        capability=Capability.PROJECT_MANAGE_READ,
    )
    if isinstance(authorized, JSONResponse):
        return authorized
    scope, _ = authorized
    async with _sm(request)() as session:
        rows = (
            await session.scalars(
                select(models.ProjectMembership)
                .where(models.ProjectMembership.project_id == uuid.UUID(scope.project_id))
                .order_by(models.ProjectMembership.id)
            )
        ).all()
    return {"memberships": [_membership_view(row) for row in rows]}


async def _known_topics(request: Request, project_id: str) -> set[str]:
    async with _sm(request)() as session:
        return set(
            await session.scalars(
                select(models.Topic.slug).where(
                    models.Topic.project_id == uuid.UUID(project_id),
                    models.Topic.status == "active",
                )
            )
        )


@router.post(
    "/memberships",
    status_code=status.HTTP_201_CREATED,
    response_model=MembershipEnvelope,
    response_model_exclude_unset=True,
)
async def create_membership(
    body: MembershipCreate,
    request: Request,
    project: str | None = None,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> Any:
    actor = await _actor(request)
    action = f"membership:create target={body.user_id}"
    authorized = await _content_scope(
        request,
        actor,
        project,
        target_action=action,
        capability=Capability.PROJECT_CONFIG_WRITE,
    )
    if isinstance(authorized, JSONResponse):
        return authorized
    scope, _ = authorized
    if body.role not in _PROJECT_ROLES:
        correlation = await _audit(request, actor, scope.project_id, action, denied=True)
        return JSONResponse(
            status_code=400,
            content={"detail": "unknown role", "audit_correlation": correlation},
        )
    unknown = set(body.allowed_topics) - await _known_topics(request, scope.project_id)
    if unknown:
        correlation = await _audit(request, actor, scope.project_id, action, denied=True)
        return JSONResponse(
            status_code=400,
            content={"detail": "unknown topics", "audit_correlation": correlation},
        )
    key = _require_key(idempotency_key)
    request_body = body.model_dump()
    prior = await _replay(request, actor, action, key, request_body)
    if prior is not None:
        return prior
    try:
        uid = uuid.UUID(body.user_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="not found") from None
    async with session_scope(_sm(request)) as session:
        locked_prior = await _locked_replay(session, actor, action, key, request_body)
        if locked_prior is not None:
            return locked_prior
        await commands.lock_resource(session, f"membership:{scope.project_id}:{body.user_id}")
        user = await session.get(models.User, uid)
        if user is None:
            raise HTTPException(status_code=404, detail="not found")
        existing = await session.scalar(
            select(models.ProjectMembership).where(
                models.ProjectMembership.user_id == uid,
                models.ProjectMembership.project_id == uuid.UUID(scope.project_id),
            )
        )
        if existing is not None:
            correlation = await _audit_in_session(
                session, actor, scope.project_id, action, denied=True
            )
            return JSONResponse(
                status_code=409,
                content={"current": _membership_view(existing), "audit_correlation": correlation},
            )
        membership = models.ProjectMembership(
            user_id=uid,
            project_id=uuid.UUID(scope.project_id),
            role=body.role,
            allowed_topics=body.allowed_topics,
            can_curate=body.can_curate,
            status="active",
            version=1,
        )
        session.add(membership)
        await session.flush()
        metadata = _membership_view(membership)
        correlation = await _audit_in_session(session, actor, scope.project_id, action)
        safe = {"membership": metadata, "audit_correlation": correlation}
        _remember_in_session(
            session,
            actor,
            project_id=scope.project_id,
            operation=action,
            key=key,
            body=request_body,
            safe_response=safe,
            audit_id=correlation,
        )
    return safe


@router.patch(
    "/memberships/{user_id}",
    response_model=MembershipTransition,
    response_model_exclude_unset=True,
)
async def update_membership(
    user_id: str,
    body: MembershipUpdate,
    request: Request,
    project: str | None = None,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> Any:
    actor = await _actor(request)
    action = f"membership:update target={user_id}"
    authorized = await _content_scope(
        request,
        actor,
        project,
        target_action=action,
        capability=Capability.PROJECT_CONFIG_WRITE,
    )
    if isinstance(authorized, JSONResponse):
        return authorized
    scope, _ = authorized
    if body.role is not None and body.role not in _PROJECT_ROLES:
        correlation = await _audit(request, actor, scope.project_id, action, denied=True)
        return JSONResponse(
            status_code=400,
            content={"detail": "unknown role", "audit_correlation": correlation},
        )
    if body.allowed_topics is not None:
        unknown = set(body.allowed_topics) - await _known_topics(request, scope.project_id)
        if unknown:
            correlation = await _audit(request, actor, scope.project_id, action, denied=True)
            return JSONResponse(
                status_code=400,
                content={"detail": "unknown topics", "audit_correlation": correlation},
            )
    key = _require_key(idempotency_key)
    request_body = body.model_dump(exclude_none=True)
    prior = await _replay(request, actor, action, key, request_body)
    if prior is not None:
        return prior
    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="not found") from None
    async with session_scope(_sm(request)) as session:
        locked_prior = await _locked_replay(session, actor, action, key, request_body)
        if locked_prior is not None:
            return locked_prior
        membership = await session.scalar(
            select(models.ProjectMembership)
            .where(
                models.ProjectMembership.user_id == uid,
                models.ProjectMembership.project_id == uuid.UUID(scope.project_id),
            )
            .with_for_update()
        )
        if membership is None:
            raise HTTPException(status_code=404, detail="not found")
        before = _membership_view(membership)
        if membership.version != body.expected_version:
            correlation = await _audit_in_session(
                session, actor, scope.project_id, action, denied=True
            )
            return JSONResponse(
                status_code=409,
                content={"current": before, "audit_correlation": correlation},
            )
        if body.role is not None:
            membership.role = body.role
        if body.allowed_topics is not None:
            membership.allowed_topics = body.allowed_topics
        if body.can_curate is not None:
            membership.can_curate = body.can_curate
        membership.version += 1
        await session.flush()
        after = _membership_view(membership)
        correlation = await _audit_in_session(session, actor, scope.project_id, action)
        safe = {"before": before, "after": after, "audit_correlation": correlation}
        _remember_in_session(
            session,
            actor,
            project_id=scope.project_id,
            operation=action,
            key=key,
            body=request_body,
            safe_response=safe,
            audit_id=correlation,
        )
    return safe


@router.get("/topics", response_model=TopicList)
async def list_topics(request: Request, project: str | None = None) -> Any:
    actor = await _actor(request)
    action = f"topic:list target={project or 'current'}"
    authorized = await _content_scope(
        request,
        actor,
        project,
        target_action=action,
        capability=Capability.PROJECT_MANAGE_READ,
    )
    if isinstance(authorized, JSONResponse):
        return authorized
    scope, _ = authorized
    async with _sm(request)() as session:
        rows = (
            await session.scalars(
                select(models.Topic)
                .where(models.Topic.project_id == uuid.UUID(scope.project_id))
                .order_by(models.Topic.slug)
            )
        ).all()
    return {"topics": [_topic_view(row) for row in rows]}


@router.post(
    "/topics",
    status_code=status.HTTP_201_CREATED,
    response_model=TopicEnvelope,
    response_model_exclude_unset=True,
)
async def create_topic(
    body: TopicCreate,
    request: Request,
    project: str | None = None,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> Any:
    actor = await _actor(request)
    action = f"topic:create target={body.slug}"
    authorized = await _content_scope(
        request,
        actor,
        project,
        target_action=action,
        capability=Capability.PROJECT_CONFIG_WRITE,
    )
    if isinstance(authorized, JSONResponse):
        return authorized
    scope, _ = authorized
    key = _require_key(idempotency_key)
    request_body = body.model_dump()
    prior = await _replay(request, actor, action, key, request_body)
    if prior is not None:
        return prior
    async with session_scope(_sm(request)) as session:
        locked_prior = await _locked_replay(session, actor, action, key, request_body)
        if locked_prior is not None:
            return locked_prior
        await commands.lock_resource(session, f"topic:{scope.project_id}:{body.slug}")
        existing = await session.scalar(
            select(models.Topic).where(
                models.Topic.project_id == uuid.UUID(scope.project_id),
                models.Topic.slug == body.slug,
            )
        )
        if existing is not None:
            correlation = await _audit_in_session(
                session, actor, scope.project_id, action, denied=True
            )
            return JSONResponse(
                status_code=409,
                content={"current": _topic_view(existing), "audit_correlation": correlation},
            )
        topic = models.Topic(
            project_id=uuid.UUID(scope.project_id),
            slug=body.slug,
            name=body.name,
            sensitivity=body.sensitivity,
            hard_window_days=body.hard_window_days,
            status="active",
            version=1,
        )
        session.add(topic)
        await session.flush()
        granted_topics = list(scope.allowed_topics)
        creator_membership = await session.scalar(
            select(models.ProjectMembership).where(
                models.ProjectMembership.user_id == uuid.UUID(actor.user_id),
                models.ProjectMembership.project_id == uuid.UUID(scope.project_id),
            )
        )
        if creator_membership is not None and body.slug not in creator_membership.allowed_topics:
            creator_membership.allowed_topics = [*creator_membership.allowed_topics, body.slug]
            creator_membership.version += 1
            granted_topics = list(creator_membership.allowed_topics)
        metadata = _topic_view(topic)
        correlation = await _audit_in_session(session, actor, scope.project_id, action)
        safe = {
            "topic": metadata,
            "topic_id": metadata["id"],
            "slug": body.slug,
            "granted_topics": granted_topics,
            "audit_correlation": correlation,
        }
        _remember_in_session(
            session,
            actor,
            project_id=scope.project_id,
            operation=action,
            key=key,
            body=request_body,
            safe_response=safe,
            audit_id=correlation,
        )
    return safe


@router.patch(
    "/topics/{slug}",
    response_model=TopicTransition,
    response_model_exclude_unset=True,
)
async def update_topic(
    slug: str,
    body: TopicUpdate,
    request: Request,
    project: str | None = None,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> Any:
    actor = await _actor(request)
    action = f"topic:update target={slug}"
    authorized = await _content_scope(
        request,
        actor,
        project,
        target_action=action,
        capability=Capability.PROJECT_CONFIG_WRITE,
    )
    if isinstance(authorized, JSONResponse):
        return authorized
    scope, _ = authorized
    key = _require_key(idempotency_key)
    request_body = body.model_dump(exclude_none=True)
    prior = await _replay(request, actor, action, key, request_body)
    if prior is not None:
        return prior
    async with session_scope(_sm(request)) as session:
        locked_prior = await _locked_replay(session, actor, action, key, request_body)
        if locked_prior is not None:
            return locked_prior
        topic = await session.scalar(
            select(models.Topic)
            .where(
                models.Topic.project_id == uuid.UUID(scope.project_id),
                models.Topic.slug == slug,
            )
            .with_for_update()
        )
        if topic is None:
            raise HTTPException(status_code=404, detail="not found")
        before = _topic_view(topic)
        if topic.version != body.expected_version:
            correlation = await _audit_in_session(
                session, actor, scope.project_id, action, denied=True
            )
            return JSONResponse(
                status_code=409,
                content={"current": before, "audit_correlation": correlation},
            )
        if body.name is not None:
            topic.name = body.name
        if body.sensitivity is not None:
            topic.sensitivity = body.sensitivity
        if "hard_window_days" in body.model_fields_set:
            topic.hard_window_days = body.hard_window_days
        topic.version += 1
        await session.flush()
        after = _topic_view(topic)
        correlation = await _audit_in_session(session, actor, scope.project_id, action)
        safe = {"before": before, "after": after, "audit_correlation": correlation}
        _remember_in_session(
            session,
            actor,
            project_id=scope.project_id,
            operation=action,
            key=key,
            body=request_body,
            safe_response=safe,
            audit_id=correlation,
        )
    return safe
