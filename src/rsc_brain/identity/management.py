"""Shared primitives for durable console-management commands.

The HTTP layer owns authorization and resource transitions.  This module owns the two invariants
every mutation shares: a retry is matched against the original request, and the replayed envelope
comes from durable, secret-free Postgres state.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import uuid
from base64 import urlsafe_b64decode, urlsafe_b64encode
from binascii import Error as Base64Error
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope


class IdempotencyMismatch(ValueError):
    """An idempotency key was reused for a different request."""

    def __init__(self, message: str, *, project_id: str) -> None:
        super().__init__(message)
        self.project_id = project_id


class InvalidUserCursor(ValueError):
    """A user-list cursor was malformed, tampered with, or issued for another authority."""


@dataclass(frozen=True)
class CommandState:
    """Persisted state for a command that may span more than one backing store."""

    project_id: str
    status: str
    response: dict[str, object]
    audit_id: int


def _cursor_key(sessionmaker: async_sessionmaker[AsyncSession]) -> bytes:
    bind = sessionmaker.kw.get("bind")
    if not isinstance(bind, AsyncEngine) or not bind.url.password:
        raise RuntimeError("management cursor signing requires a credentialed database URL")
    namespace = f"{bind.url.username or ''}/{bind.url.database or ''}".encode()
    return hmac.new(
        bind.url.password.encode(),
        b"rsc-brain:management-user-cursor:v1\0" + namespace,
        hashlib.sha256,
    ).digest()


def _b64encode(value: bytes) -> str:
    return urlsafe_b64encode(value).decode().rstrip("=")


def _b64decode(value: str) -> bytes:
    return urlsafe_b64decode(f"{value}{'=' * (-len(value) % 4)}".encode())


def encode_user_cursor(
    sessionmaker: async_sessionmaker[AsyncSession],
    *,
    principal_id: str,
    project_id: str,
    email: str,
    user_id: str,
) -> str:
    payload = _b64encode(
        json.dumps(
            {"v": 1, "email": email, "user_id": user_id},
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    )
    context = f"{principal_id}\0{project_id}\0{payload}".encode()
    signature = _b64encode(hmac.new(_cursor_key(sessionmaker), context, hashlib.sha256).digest())
    return f"{payload}.{signature}"


def decode_user_cursor(
    sessionmaker: async_sessionmaker[AsyncSession],
    *,
    principal_id: str,
    project_id: str,
    value: str,
) -> tuple[str, uuid.UUID]:
    try:
        payload, signature, *extra = value.split(".")
        if extra or not payload or not signature:
            raise ValueError
        expected = hmac.new(
            _cursor_key(sessionmaker),
            f"{principal_id}\0{project_id}\0{payload}".encode(),
            hashlib.sha256,
        ).digest()
        if not hmac.compare_digest(_b64decode(signature), expected):
            raise ValueError
        decoded = json.loads(_b64decode(payload))
        if not isinstance(decoded, dict) or decoded.get("v") != 1:
            raise ValueError
        email = decoded["email"]
        if not isinstance(email, str):
            raise ValueError
        return email, uuid.UUID(decoded["user_id"])
    except (Base64Error, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise InvalidUserCursor("invalid cursor") from exc


def request_fingerprint(payload: Mapping[str, object]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode()
    return hashlib.sha256(encoded).hexdigest()


async def replay(
    sessionmaker: async_sessionmaker[AsyncSession],
    *,
    principal_id: str,
    operation: str,
    idempotency_key: str,
    request: Mapping[str, object],
) -> dict[str, object] | None:
    async with sessionmaker() as session:
        row = await session.scalar(
            select(models.ManagementCommand).where(
                models.ManagementCommand.principal_id == principal_id,
                models.ManagementCommand.operation == operation,
                models.ManagementCommand.idempotency_key == idempotency_key,
            )
        )
    if row is None:
        return None
    if row.request_hash != request_fingerprint(request):
        raise IdempotencyMismatch(
            "Idempotency-Key was already used for another request",
            project_id=str(row.project_id),
        )
    if row.status != "completed":
        return None
    return {**row.response, "replayed": True}


async def read_command(
    session: AsyncSession,
    *,
    principal_id: str,
    operation: str,
    idempotency_key: str,
    request: Mapping[str, object],
) -> CommandState | None:
    """Read and validate a command while the caller holds its serialization lock."""

    row = await session.scalar(
        select(models.ManagementCommand).where(
            models.ManagementCommand.principal_id == principal_id,
            models.ManagementCommand.operation == operation,
            models.ManagementCommand.idempotency_key == idempotency_key,
        )
    )
    if row is None:
        return None
    if row.request_hash != request_fingerprint(request):
        raise IdempotencyMismatch(
            "Idempotency-Key was already used for another request",
            project_id=str(row.project_id),
        )
    return CommandState(
        project_id=str(row.project_id),
        status=row.status,
        response=dict(row.response),
        audit_id=row.audit_id,
    )


@asynccontextmanager
async def serialized_command(
    sessionmaker: async_sessionmaker[AsyncSession],
    *,
    operation: str,
) -> AsyncIterator[AsyncSession]:
    """Hold a Postgres session lock across a multi-store management saga.

    Transaction-level locks protect ordinary one-database commands. Project erasure also touches
    AGE and the filesystem, so its lock must survive the Postgres commits that checkpoint the saga.
    A dead process releases this session lock automatically and a retry resumes from the ledger.
    """

    # Operation includes the concrete target. Deliberately omit principal/key so two owners cannot
    # run the same destructive saga concurrently under different retry keys.
    lock_name = f"management-saga:{operation}"
    async with sessionmaker() as session:
        await session.execute(select(func.pg_advisory_lock(func.hashtextextended(lock_name, 0))))
        try:
            yield session
        finally:
            await session.execute(
                select(func.pg_advisory_unlock(func.hashtextextended(lock_name, 0)))
            )


async def locked_replay(
    session: AsyncSession,
    *,
    principal_id: str,
    operation: str,
    idempotency_key: str,
    request: Mapping[str, object],
) -> dict[str, object] | None:
    """Serialize one command key and re-check its durable result in the mutation transaction."""

    lock_name = f"management:{principal_id}:{operation}:{idempotency_key}"
    await session.execute(select(func.pg_advisory_xact_lock(func.hashtextextended(lock_name, 0))))
    row = await session.scalar(
        select(models.ManagementCommand).where(
            models.ManagementCommand.principal_id == principal_id,
            models.ManagementCommand.operation == operation,
            models.ManagementCommand.idempotency_key == idempotency_key,
        )
    )
    if row is None:
        return None
    if row.request_hash != request_fingerprint(request):
        raise IdempotencyMismatch(
            "Idempotency-Key was already used for another request",
            project_id=str(row.project_id),
        )
    if row.status != "completed":
        return None
    return {**row.response, "replayed": True}


async def lock_resource(session: AsyncSession, resource: str) -> None:
    """Serialize creates that target one natural key, even when retry keys differ."""

    await session.execute(
        select(
            func.pg_advisory_xact_lock(func.hashtextextended(f"management-resource:{resource}", 0))
        )
    )


def remember_in_session(
    session: AsyncSession,
    *,
    project_id: str,
    principal_id: str,
    operation: str,
    idempotency_key: str,
    request: Mapping[str, object],
    response: Mapping[str, object],
    audit_id: int,
    status: str = "completed",
) -> None:
    session.add(
        models.ManagementCommand(
            project_id=uuid.UUID(project_id),
            principal_id=principal_id,
            operation=operation,
            idempotency_key=idempotency_key,
            request_hash=request_fingerprint(request),
            response=dict(response),
            audit_id=audit_id,
            status=status,
        )
    )


async def mark_completed(
    sessionmaker: async_sessionmaker[AsyncSession],
    *,
    principal_id: str,
    operation: str,
    idempotency_key: str,
) -> None:
    """Commit the terminal checkpoint of a previously persisted multi-store command."""

    async with session_scope(sessionmaker) as session:
        await session.execute(
            update(models.ManagementCommand)
            .where(
                models.ManagementCommand.principal_id == principal_id,
                models.ManagementCommand.operation == operation,
                models.ManagementCommand.idempotency_key == idempotency_key,
                models.ManagementCommand.status == "pending",
            )
            .values(status="completed")
        )


async def remember(
    sessionmaker: async_sessionmaker[AsyncSession],
    *,
    project_id: str,
    principal_id: str,
    operation: str,
    idempotency_key: str,
    request: Mapping[str, object],
    response: Mapping[str, object],
    audit_id: int,
) -> None:
    async with session_scope(sessionmaker) as session:
        remember_in_session(
            session,
            project_id=project_id,
            principal_id=principal_id,
            operation=operation,
            idempotency_key=idempotency_key,
            request=request,
            response=response,
            audit_id=audit_id,
        )
