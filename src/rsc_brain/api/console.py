"""Console-facing API (SPEC-07 backend prerequisites): session login on the single D11 identity,
``/me`` (user + memberships), and self-service PAT management (FR-4.13 user part).

Auth here is a **console session** bearer token (``cks_…``), distinct from the MCP/admin PAT: the
browser holds an httpOnly session cookie that the Next server forwards as a bearer. All authority
is the API's — the console only reflects roles. Every mutation reuses SPEC-04 services and is
auditable; a revoked PAT/session stops resolving in <5s.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.identity import sessions
from rsc_brain.identity.service import IdentityService
from rsc_brain.identity.sessions import SessionUser

_bearer = HTTPBearer(auto_error=False)

auth_router = APIRouter(prefix="/api/v1/auth", tags=["console-auth"])
me_router = APIRouter(prefix="/api/v1/me", tags=["console-me"])


class LoginRequest(BaseModel):
    email: str
    password: str


class CreatePatRequest(BaseModel):
    project: str
    name: str | None = None


def _sessionmaker(request: Request) -> async_sessionmaker[AsyncSession]:
    sessionmaker: async_sessionmaker[AsyncSession] = request.app.state.deps.sessionmaker
    return sessionmaker


async def _session_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> SessionUser:
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing session")
    user = await sessions.resolve_session(_sessionmaker(request), credentials.credentials)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid session")
    return user


@auth_router.post("/login")
async def login(body: LoginRequest, request: Request) -> dict[str, object]:
    token = await sessions.login(_sessionmaker(request), body.email, body.password)
    if token is None:
        # Unknown email, wrong password, and inactive user are all one indistinguishable 401.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")
    return {"session_token": token}


@auth_router.post("/logout")
async def logout(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict[str, object]:
    if credentials is not None:
        await sessions.logout(_sessionmaker(request), credentials.credentials)
    return {"ok": True}


@me_router.get("")
async def me(request: Request, user: SessionUser = Depends(_session_user)) -> dict[str, object]:
    memberships = await sessions.list_memberships(_sessionmaker(request), user.user_id)
    return {
        "user": {"id": user.user_id, "email": user.email, "role": user.role},
        "is_owner": user.is_owner,
        "memberships": sessions.memberships_payload(memberships),
    }


@me_router.get("/pats")
async def list_pats(
    request: Request, user: SessionUser = Depends(_session_user)
) -> dict[str, object]:
    return {"pats": await sessions.list_user_pats(_sessionmaker(request), user.user_id)}


@me_router.post("/pats", status_code=status.HTTP_201_CREATED)
async def create_pat(
    body: CreatePatRequest, request: Request, user: SessionUser = Depends(_session_user)
) -> dict[str, object]:
    sessionmaker = _sessionmaker(request)
    membership_id = await sessions.membership_for(sessionmaker, user.user_id, body.project)
    if membership_id is None:
        # Not a member of that project (or it does not exist): denied ≡ absent.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    issued = await IdentityService(sessionmaker).issue_pat(membership_id, name=body.name)
    # The secret is shown exactly once.
    return {"pat_id": issued.id, "token": issued.token}


@me_router.delete("/pats/{pat_id}")
async def revoke_pat(
    pat_id: str, request: Request, user: SessionUser = Depends(_session_user)
) -> dict[str, object]:
    sessionmaker = _sessionmaker(request)
    if not await sessions.owns_pat(sessionmaker, user.user_id, pat_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    await IdentityService(sessionmaker).revoke_pat(pat_id)
    return {"ok": True, "revoked": pat_id}


@me_router.get("/connections")
async def list_connections(
    request: Request, user: SessionUser = Depends(_session_user)
) -> dict[str, object]:
    """The user's OAuth connections (FR-4.13) — what Claude/ChatGPT connections exist."""
    return {
        "connections": await sessions.list_user_connections(_sessionmaker(request), user.user_id)
    }


@me_router.delete("/connections/{connection_id}")
async def revoke_connection(
    connection_id: str, request: Request, user: SessionUser = Depends(_session_user)
) -> dict[str, object]:
    sessionmaker = _sessionmaker(request)
    if not await sessions.owns_connection(sessionmaker, user.user_id, connection_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    await sessions.revoke_connection(sessionmaker, connection_id)
    return {"ok": True, "revoked": connection_id}
