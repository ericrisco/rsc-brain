"""Project-scoped, deduplicated administrator alerts for final-context blocks."""

from __future__ import annotations

import datetime as dt
import hashlib
import uuid
from collections.abc import Callable, Sequence

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.audit import record_audit_in_session
from rsc_brain.hunting.channels import Channel, OutboundMessage
from rsc_brain.scope import PROJECT_ROLE_ADMIN, ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope

_DEDUPE_WINDOW = dt.timedelta(hours=1)


def _uuid_values(values: Sequence[str]) -> list[uuid.UUID]:
    parsed: list[uuid.UUID] = []
    for value in values:
        try:
            parsed.append(uuid.UUID(value))
        except (TypeError, ValueError):
            continue
    return list(dict.fromkeys(parsed))


def _event_hash(project_id: str, resource_ids: Sequence[str], reason: str) -> str:
    material = ":".join([project_id, reason, *sorted(resource_ids)])
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def _advisory_key(event_hash: str) -> int:
    return int.from_bytes(bytes.fromhex(event_hash[:16]), "big", signed=True)


class GuardrailAlertService:
    """Notify one project administrator without leaking blocked identifiers.

    Equivalent alerts converge under a PostgreSQL transaction advisory lock. A provider can still
    accept a send immediately before the process dies and the transaction rolls back; the generic
    SMTP/Slack boundary offers no atomic delivery receipt, so that residual is explicit rather than
    mislabeled exactly-once.
    """

    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        channel: Channel | None = None,
        can_deliver: bool = False,
        dedupe_window: dt.timedelta = _DEDUPE_WINDOW,
        clock: Callable[[], dt.datetime] | None = None,
    ) -> None:
        self._sm = sessionmaker
        self._channel = channel
        self._can_deliver = can_deliver
        self._window = dedupe_window
        self._clock = clock or (lambda: dt.datetime.now(dt.UTC))

    async def notify(
        self,
        scope: ProjectScope,
        claim_ids: Sequence[str],
        *,
        chunk_ids: Sequence[str] = (),
        reason: str,
    ) -> bool:
        """Send one alert, or return False for dedupe/unavailable/failure/no local claims."""
        requested = _uuid_values(claim_ids)
        requested_chunks = _uuid_values(chunk_ids)
        if not requested and not requested_chunks:
            return False

        async with session_scope(self._sm) as session:
            local_claims = list(
                await session.scalars(
                    select(models.Claim.id)
                    .where(
                        models.Claim.project_id == uuid.UUID(scope.project_id),
                        models.Claim.id.in_(requested),
                    )
                    .order_by(models.Claim.id)
                )
            )
            local_chunks = list(
                await session.scalars(
                    select(models.Chunk.id)
                    .where(
                        models.Chunk.project_id == uuid.UUID(scope.project_id),
                        models.Chunk.id.in_(requested_chunks),
                    )
                    .order_by(models.Chunk.id)
                )
            )
            resources = [*(f"claim:{item}" for item in local_claims)]
            resources.extend(f"chunk:{item}" for item in local_chunks)
            resources = list(dict.fromkeys(resources))
            if not resources:
                return False

            event_hash = _event_hash(scope.project_id, resources, reason)
            await session.execute(
                text("SELECT pg_advisory_xact_lock(:key)"), {"key": _advisory_key(event_hash)}
            )
            already_sent = await session.scalar(
                select(models.AuditLog.id)
                .where(
                    models.AuditLog.project_id == uuid.UUID(scope.project_id),
                    models.AuditLog.action == "guardrail:admin_alerted",
                    models.AuditLog.query_hash == event_hash,
                    models.AuditLog.ts >= self._clock() - self._window,
                )
                .limit(1)
            )
            if already_sent is not None:
                return False

            recipient = await self._recipient(session, scope)
            if not self._can_deliver or self._channel is None or recipient is None:
                await record_audit_in_session(
                    session,
                    scope,
                    action="guardrail:alert_unavailable",
                    tool="guardrail",
                    query_hash=event_hash,
                    result_count=0,
                    denied=True,
                )
                return False

            message = OutboundMessage(
                channel=self._channel.name,
                to=recipient,
                subject="rsc-brain blocked final context",
                body=(
                    f"The final-context guardrail blocked knowledge as {reason}. "
                    "Review the project's knowledge review queue."
                ),
            )
            try:
                await self._channel.send(message)
            except Exception:
                await record_audit_in_session(
                    session,
                    scope,
                    action="guardrail:alert_failed",
                    tool="guardrail",
                    query_hash=event_hash,
                    result_count=0,
                    denied=True,
                )
                return False

            await record_audit_in_session(
                session,
                scope,
                action="guardrail:admin_alerted",
                tool="guardrail",
                query_hash=event_hash,
                result_count=1,
                denied=True,
            )
            return True

    async def _recipient(self, session: AsyncSession, scope: ProjectScope) -> str | None:
        if self._channel is not None and self._channel.name == "slack":
            return ""
        recipient = await session.scalar(
            select(models.User.email)
            .join(
                models.ProjectMembership,
                models.ProjectMembership.user_id == models.User.id,
            )
            .where(
                models.ProjectMembership.project_id == uuid.UUID(scope.project_id),
                models.ProjectMembership.role == PROJECT_ROLE_ADMIN,
                models.ProjectMembership.status == "active",
                models.User.status == "active",
            )
            .order_by(models.User.email)
            .limit(1)
        )
        return str(recipient) if recipient is not None else None
