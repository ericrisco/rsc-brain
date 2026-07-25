"""OAuth 2.1 HTTP surface (SPEC-10): DCR, authorize+consent, token, and discovery metadata.

The security-critical flow runs in :mod:`rsc_brain.api.oauth.server` (Authlib, sync) inside a
threadpool so the async event loop is never blocked. These routes are the thin adapter: read the
request, identify the logged-in user for consent (the SPEC-07 console session), and translate
Authlib's ``(status, body, headers)`` into a Starlette response. DCR persistence is async (no
Authlib needed to store a client). Login/consent *pages* are refined in increment C; the consent
mechanism + project selector live here.
"""

from __future__ import annotations

import html
import json
import secrets
import uuid
from dataclasses import dataclass, field
from typing import Any

from fastapi import APIRouter, Form, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response
from sqlalchemy import select
from starlette.concurrency import run_in_threadpool

from rsc_brain.api.oauth.server import GrantUser, build_authorization_server
from rsc_brain.api.origin import external_origin
from rsc_brain.identity.sessions import list_memberships, resolve_session
from rsc_brain.security import SESSION_PREFIX
from rsc_brain.stores.relational import models

router = APIRouter(tags=["oauth"])

_SESSION_COOKIE = "cks_session"
_DEFAULT_GRANT_TYPES = ["authorization_code", "refresh_token"]


@dataclass(slots=True)
class _Req:
    """Minimal request view Authlib's ``create_oauth2_request`` consumes (sync-safe: pre-read)."""

    method: str
    uri: str
    body: dict[str, Any] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)


def _to_response(result: Any) -> Response:
    status_code, body, headers = result
    header_map = dict(headers) if headers else {}
    content = body if isinstance(body, str) else json.dumps(body or {})
    return Response(content=content, status_code=status_code, headers=header_map)


def _sync_sessionmaker(request: Request) -> Any:
    sm = request.app.state.deps.sync_sessionmaker
    if sm is None:  # pragma: no cover - misconfiguration
        raise RuntimeError("OAuth authorization server not configured (no sync sessionmaker)")
    return sm


async def _current_user_id(request: Request) -> str | None:
    token = request.cookies.get(_SESSION_COOKIE)
    if not token:
        header = request.headers.get("authorization", "")
        if header.lower().startswith("bearer ") and header[7:].startswith(SESSION_PREFIX):
            token = header[7:]
    if not token:
        return None
    user = await resolve_session(request.app.state.deps.sessionmaker, token)
    return user.user_id if user else None


@router.get("/.well-known/oauth-authorization-server")
async def authorization_server_metadata(request: Request) -> JSONResponse:
    # R51: the advertised origin comes from configuration, not from the caller's Host header — an
    # OAuth client that discovers metadata sends its authorization code and token request here.
    base = external_origin(request, getattr(request.app.state.deps, "ingress", None))
    return JSONResponse(
        {
            "issuer": base,
            "authorization_endpoint": f"{base}/oauth/authorize",
            "token_endpoint": f"{base}/oauth/token",
            "registration_endpoint": f"{base}/oauth/register",
            "response_types_supported": ["code"],
            "grant_types_supported": _DEFAULT_GRANT_TYPES,
            "code_challenge_methods_supported": ["S256"],  # PKCE required (FR-4.10)
            "token_endpoint_auth_methods_supported": ["none"],
        }
    )


@router.post("/oauth/register", status_code=201)
async def register_client(request: Request) -> JSONResponse:
    """Dynamic Client Registration (RFC 7591) — Claude/ChatGPT register here before connecting."""
    body = await request.json()
    redirect_uris = body.get("redirect_uris")
    if not isinstance(redirect_uris, list) or not redirect_uris:
        return JSONResponse({"error": "invalid_redirect_uri"}, status_code=400)
    metadata = {
        "redirect_uris": redirect_uris,
        "client_name": body.get("client_name"),
        "grant_types": body.get("grant_types") or _DEFAULT_GRANT_TYPES,
        "response_types": body.get("response_types") or ["code"],
        "token_endpoint_auth_method": body.get("token_endpoint_auth_method") or "none",
        "scope": body.get("scope") or "",
    }
    client_id = f"dcr-{secrets.token_urlsafe(18)}"
    async with request.app.state.deps.sessionmaker() as session:
        session.add(models.OAuthClient(client_id=client_id, client_metadata=metadata))
        await session.commit()
    return JSONResponse(
        {"client_id": client_id, "token_endpoint_auth_method": "none", **metadata},
        status_code=201,
    )


def _consent_page(client_name: str, memberships: list[Any], query: str) -> str:
    options = "\n".join(
        f'<option value="{html.escape(m.project_id)}">{html.escape(m.project_slug)}</option>'
        for m in memberships
    )
    single = len(memberships) == 1
    selector = (
        f'<input type="hidden" name="membership_project_id" value="{html.escape(memberships[0].project_id)}">'
        if single
        else f'<label>Project: <select name="membership_project_id">{options}</select></label>'
    )
    return f"""<!doctype html><html><head><title>Authorize {html.escape(client_name)}</title></head>
<body>
<h1>Authorize {html.escape(client_name)}</h1>
<p><strong>{html.escape(client_name)}</strong> is requesting access to your rsc-brain on your behalf.</p>
<form method="post" action="/oauth/authorize?{html.escape(query)}">
{selector}
<button type="submit" name="consent" value="allow">Allow</button>
<button type="submit" name="consent" value="deny">Deny</button>
</form>
</body></html>"""


@router.get("/oauth/authorize")
async def authorize_get(request: Request) -> Response:
    user_id = await _current_user_id(request)
    if user_id is None:
        # Not logged in — the login page (increment C) will post here after auth.
        return HTMLResponse(
            "<html><body><h1>Login required</h1>"
            "<p>Sign in to the console, then retry the connection.</p></body></html>",
            status_code=401,
        )
    params = request.query_params
    client_id = params.get("client_id")
    async with request.app.state.deps.sessionmaker() as session:
        client = await session.scalar(
            select(models.OAuthClient).where(models.OAuthClient.client_id == client_id)
        )
    if client is None:
        return JSONResponse({"error": "invalid_client"}, status_code=400)
    redirect_uri = params.get("redirect_uri")
    registered = (client.client_metadata or {}).get("redirect_uris") or []
    if redirect_uri is not None and redirect_uri not in registered:
        return JSONResponse({"error": "invalid_redirect_uri"}, status_code=400)
    memberships = await list_memberships(request.app.state.deps.sessionmaker, user_id)
    if not memberships:
        return JSONResponse({"error": "access_denied", "detail": "no project membership"}, 403)
    client_name = str((client.client_metadata or {}).get("client_name") or client.client_id)
    return HTMLResponse(_consent_page(client_name, memberships, str(params)))


@router.post("/oauth/authorize")
async def authorize_post(
    request: Request,
    consent: str = Form(...),
    membership_project_id: str = Form(...),
) -> Response:
    user_id = await _current_user_id(request)
    if user_id is None:
        return JSONResponse({"error": "access_denied"}, status_code=401)
    # The chosen project must be one THIS user is a member of (never trust the form alone).
    membership = await _membership_for(request, user_id, membership_project_id)
    if membership is None:
        return JSONResponse({"error": "access_denied"}, status_code=403)

    uri = str(request.url)
    headers = dict(request.headers)
    grant_user = (
        GrantUser(membership_id=membership, user_id=user_id) if consent == "allow" else None
    )
    sm = _sync_sessionmaker(request)

    def _authorize() -> Any:
        with sm() as session:
            server = build_authorization_server(session)
            oauth_request = server.create_oauth2_request(
                _Req(method="POST", uri=uri, headers=headers)
            )
            grant = server.get_authorization_grant(oauth_request)
            return server.create_authorization_response(
                request=oauth_request, grant_user=grant_user, grant=grant
            )

    return _to_response(await run_in_threadpool(_authorize))


@router.post("/oauth/token")
async def token(request: Request) -> Response:
    form = dict(await request.form())
    uri = str(request.url)
    headers = dict(request.headers)
    sm = _sync_sessionmaker(request)

    def _token() -> Any:
        with sm() as session:
            server = build_authorization_server(session)
            req = _Req(method="POST", uri=uri, body=form, headers=headers)
            return server.create_token_response(req)

    return _to_response(await run_in_threadpool(_token))


async def _membership_for(request: Request, user_id: str, project_id: str) -> str | None:
    async with request.app.state.deps.sessionmaker() as session:
        row = await session.scalar(
            select(models.ProjectMembership.id).where(
                models.ProjectMembership.user_id == uuid.UUID(user_id),
                models.ProjectMembership.project_id == uuid.UUID(project_id),
            )
        )
    return str(row) if row is not None else None
