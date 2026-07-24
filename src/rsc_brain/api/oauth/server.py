"""The OAuth 2.1 authorization server (SPEC-10, FR-4.10) — Authlib, no artesanal OAuth.

Authlib's ``AuthorizationServer`` and its grants are **synchronous**, so this module runs over a
**sync** SQLAlchemy session (the FastAPI routes call it inside a threadpool). Authlib owns the
security-critical machinery: PKCE (``CodeChallenge(required=True)`` — S256, reject without a
challenge), the ``authorization_code`` + ``refresh_token`` grants with rotation, token/error
formats, and DCR (RFC 7591). We implement only persistence glue over the project's existing tables
(``oauth_clients`` / ``oauth_tokens`` / ``oauth_authorization_codes``): tokens are **membership-
bound and stored hashed**, so an issued access token resolves through the same async
``resolve_scope`` path as a PAT (SPEC-10 increment A).

A fresh server is built per request, bound to that request's sync session — no shared mutable
state across requests.
"""

from __future__ import annotations

import datetime as dt
import secrets
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qsl, urlparse

from authlib.oauth2.rfc6749 import AuthorizationServer, ClientMixin, grants
from authlib.oauth2.rfc6749.requests import BasicOAuth2Payload, JsonRequest, OAuth2Request
from authlib.oauth2.rfc6750 import BearerTokenGenerator
from authlib.oauth2.rfc7636 import CodeChallenge
from sqlalchemy import select
from sqlalchemy.orm import Session

from rsc_brain import security
from rsc_brain.stores.relational import models

ACCESS_TOKEN_TTL_SECONDS = 3600  # FR-4.10: access token ≤ 1h
_CODE_TTL_SECONDS = 300
_DEFAULT_GRANT_TYPES = ["authorization_code", "refresh_token"]
_DEFAULT_RESPONSE_TYPES = ["code"]


def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


@dataclass(slots=True)
class GrantUser:
    """The (user, project) principal a code/token is bound to — carries the membership id."""

    membership_id: str
    user_id: str

    def get_user_id(self) -> str:
        return self.user_id


class _Client(ClientMixin):
    """Adapts an ``oauth_clients`` row to Authlib's ClientMixin, reading policy from the DCR
    ``client_metadata``. Public clients only (PKCE, ``token_endpoint_auth_method='none'``)."""

    def __init__(self, row: models.OAuthClient) -> None:
        self.row_id = row.id
        self.client_id = row.client_id
        self.metadata: dict[str, Any] = dict(row.client_metadata or {})

    def get_client_id(self) -> str:
        return self.client_id

    def get_default_redirect_uri(self) -> str | None:
        uris = self.metadata.get("redirect_uris") or []
        return uris[0] if uris else None

    def get_allowed_scope(self, scope: str) -> str:
        if not scope:
            return ""
        allowed = set((self.metadata.get("scope") or "").split())
        if not allowed:
            return scope
        return " ".join(s for s in scope.split() if s in allowed)

    def check_redirect_uri(self, redirect_uri: str) -> bool:
        return redirect_uri in (self.metadata.get("redirect_uris") or [])

    def check_client_secret(self, client_secret: str) -> bool:
        return False  # public clients carry no secret

    def check_endpoint_auth_method(self, method: str, endpoint: str) -> bool:
        if endpoint == "token":
            return method == (self.metadata.get("token_endpoint_auth_method") or "none")
        return True

    def check_response_type(self, response_type: str) -> bool:
        return response_type in (self.metadata.get("response_types") or _DEFAULT_RESPONSE_TYPES)

    def check_grant_type(self, grant_type: str) -> bool:
        return grant_type in (self.metadata.get("grant_types") or _DEFAULT_GRANT_TYPES)


@dataclass(slots=True)
class _AuthCode:
    """Authlib authorization-code view over an ``oauth_authorization_codes`` row."""

    row_id: str
    membership_id: str
    redirect_uri: str | None
    scope: str
    code_challenge: str | None
    code_challenge_method: str | None

    def get_redirect_uri(self) -> str | None:
        return self.redirect_uri

    def get_scope(self) -> str:
        return self.scope or ""

    def get_nonce(self) -> None:
        return None

    def get_auth_time(self) -> None:
        return None


class _AuthorizationCodeGrant(grants.AuthorizationCodeGrant):
    # Public PKCE clients authenticate with no secret at the token endpoint.
    TOKEN_ENDPOINT_AUTH_METHODS = ["none", "client_secret_basic", "client_secret_post"]  # noqa: RUF012

    def save_authorization_code(self, code: str, request: Any) -> _AuthCode:
        session: Session = self.server.session
        challenge = request.payload.data.get("code_challenge")
        method = request.payload.data.get("code_challenge_method")
        row = models.OAuthAuthorizationCode(
            code_hash=security.token_hash(code),
            client_id=request.client.row_id,
            membership_id=request.user.membership_id,
            redirect_uri=request.payload.redirect_uri,
            scope=request.payload.scope,
            code_challenge=challenge,
            code_challenge_method=method,
            expires_at=_now() + dt.timedelta(seconds=_CODE_TTL_SECONDS),
        )
        session.add(row)
        session.commit()
        return _AuthCode(
            row_id=str(row.id),
            membership_id=str(row.membership_id),
            redirect_uri=row.redirect_uri,
            scope=row.scope or "",
            code_challenge=challenge,
            code_challenge_method=method,
        )

    def query_authorization_code(self, code: str, client: _Client) -> _AuthCode | None:
        session: Session = self.server.session
        row = session.scalar(
            select(models.OAuthAuthorizationCode).where(
                models.OAuthAuthorizationCode.code_hash == security.token_hash(code),
                models.OAuthAuthorizationCode.client_id == client.row_id,
            )
        )
        if row is None or row.used_at is not None:
            return None
        if row.expires_at is not None and row.expires_at < _now():
            return None
        return _AuthCode(
            row_id=str(row.id),
            membership_id=str(row.membership_id),
            redirect_uri=row.redirect_uri,
            scope=row.scope or "",
            code_challenge=row.code_challenge,
            code_challenge_method=row.code_challenge_method,
        )

    def delete_authorization_code(self, authorization_code: _AuthCode) -> None:
        session: Session = self.server.session
        row = session.get(models.OAuthAuthorizationCode, authorization_code.row_id)
        if row is not None:
            row.used_at = _now()  # single-use: mark, never resolves again (kept, not deleted)
            session.commit()

    def authenticate_user(self, authorization_code: _AuthCode) -> GrantUser | None:
        session: Session = self.server.session
        membership = session.get(models.ProjectMembership, authorization_code.membership_id)
        if membership is None:
            return None
        return GrantUser(membership_id=str(membership.id), user_id=str(membership.user_id))


@dataclass(slots=True)
class _RefreshCredential:
    """Authlib TokenMixin view over an ``oauth_tokens`` row for the refresh grant."""

    row_id: str
    client_row_id: Any
    membership_id: str

    def check_client(self, client: _Client) -> bool:
        return bool(self.client_row_id == client.row_id)

    def get_scope(self) -> str:
        return ""

    def save(self) -> None:  # pragma: no cover - Authlib may probe this; persistence is our job
        return None


class _RefreshTokenGrant(grants.RefreshTokenGrant):
    # Public PKCE clients (Claude/ChatGPT) refresh with no secret.
    TOKEN_ENDPOINT_AUTH_METHODS = ["none", "client_secret_basic", "client_secret_post"]  # noqa: RUF012
    INCLUDE_NEW_REFRESH_TOKEN = True  # rotation: every refresh mints a fresh refresh token

    def authenticate_refresh_token(self, refresh_token: str) -> _RefreshCredential | None:
        session: Session = self.server.session
        row = session.scalar(
            select(models.OAuthToken).where(
                models.OAuthToken.refresh_token_hash == security.token_hash(refresh_token)
            )
        )
        if row is None or row.revoked_at is not None:
            return None
        return _RefreshCredential(
            row_id=str(row.id), client_row_id=row.client_id, membership_id=str(row.membership_id)
        )

    def authenticate_user(self, credential: _RefreshCredential) -> GrantUser | None:
        session: Session = self.server.session
        membership = session.get(models.ProjectMembership, credential.membership_id)
        if membership is None:
            return None
        return GrantUser(membership_id=str(membership.id), user_id=str(membership.user_id))

    def revoke_old_credential(self, credential: _RefreshCredential) -> None:
        session: Session = self.server.session
        row = session.get(models.OAuthToken, credential.row_id)
        if row is not None:
            row.revoked_at = _now()  # rotation: the used refresh token is invalidated
            session.commit()


class RscAuthorizationServer(AuthorizationServer):
    """Framework-agnostic Authlib AS bound to a sync session + a Starlette-style request adapter."""

    def __init__(self, session: Session) -> None:
        super().__init__(scopes_supported=None)
        self.session = session

    def query_client(self, client_id: str) -> _Client | None:
        row = self.session.scalar(
            select(models.OAuthClient).where(models.OAuthClient.client_id == client_id)
        )
        return _Client(row) if row is not None else None

    def save_token(self, token: dict[str, Any], request: Any) -> None:
        user: GrantUser = request.user
        client: _Client = request.client
        expires_in = int(token.get("expires_in") or ACCESS_TOKEN_TTL_SECONDS)
        refresh = token.get("refresh_token")
        self.session.add(
            models.OAuthToken(
                membership_id=user.membership_id,
                client_id=client.row_id,
                access_token_hash=security.token_hash(token["access_token"]),
                refresh_token_hash=security.token_hash(refresh) if refresh else None,
                expires_at=_now() + dt.timedelta(seconds=expires_in),
            )
        )
        self.session.commit()

    def create_oauth2_request(self, request: Any) -> OAuth2Request:
        # Authlib 1.7 payload system: build the request, then attach the merged params (query for
        # the authorize endpoint, form body for the token endpoint) as the payload.
        query = dict(parse_qsl(urlparse(request.uri).query))
        data = {**query, **(request.body or {})}
        oauth_request = OAuth2Request(request.method, request.uri, headers=request.headers)
        oauth_request.payload = BasicOAuth2Payload(data)
        # Authlib 1.7 grants still read ``request.form`` in places; set it directly (the constructor
        # ``body=`` param is deprecated) so both the payload system and ``.form`` resolve.
        oauth_request._body = data
        return oauth_request

    def create_json_request(self, request: Any) -> JsonRequest:
        oauth_request = JsonRequest(request.method, request.uri, headers=request.headers)
        oauth_request.payload = BasicOAuth2Payload(dict(request.body or {}))
        return oauth_request

    def handle_response(self, status_code: int, payload: Any, headers: Any) -> Any:
        return (status_code, payload, headers)

    def send_signal(self, name: str, *args: Any, **kwargs: Any) -> None:
        # No signal system in this integration (the base raises NotImplementedError otherwise).
        return None


def _access_token_generator(*_args: Any, **_kwargs: Any) -> str:
    return secrets.token_urlsafe(48)


def _refresh_token_generator(*_args: Any, **_kwargs: Any) -> str:
    return secrets.token_urlsafe(48)


def _expires_generator(*_args: Any, **_kwargs: Any) -> int:
    return ACCESS_TOKEN_TTL_SECONDS


def build_authorization_server(session: Session) -> RscAuthorizationServer:
    """Construct the AS for one request, bound to ``session``. Registers the PKCE-required
    authorization_code grant + the rotating refresh grant + the bearer token generator."""
    server = RscAuthorizationServer(session)
    token_generator = BearerTokenGenerator(
        _access_token_generator, _refresh_token_generator, _expires_generator
    )
    for grant_type in _DEFAULT_GRANT_TYPES:
        server.register_token_generator(grant_type, token_generator)
    server.register_grant(_AuthorizationCodeGrant, [CodeChallenge(required=True)])
    server.register_grant(_RefreshTokenGrant)
    return server
