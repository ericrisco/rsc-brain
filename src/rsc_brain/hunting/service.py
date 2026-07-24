"""Hunt orchestration (SPEC-15, E7) — triggers → route → consent → ask → answer → claim.

Drives the :mod:`state_machine` over persisted ``hunts`` rows. A human answer via the one-time
magic link becomes a claim at ``cred=0.95`` (provenance = the person) and closes the gap. Sends go
through a :class:`~rsc_brain.hunting.channels.Channel`, never during the person's ``quiet_hours``.
Anti-spam caps open + weekly hunts per person. Timeouts (72h → one retry → escalate) are applied by
:meth:`expire_due`, called by a scheduled job (procrastinate) — here with an injectable clock so
the whole flow is deterministic in tests. ``CORRECTION_REVIEW`` hunts are handled in
:mod:`rsc_brain.hunting.corrections_review`.
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain import security
from rsc_brain.audit import record_audit
from rsc_brain.hunting.channels import Channel, NullChannel, OutboundMessage
from rsc_brain.hunting.directory import PersonDirectory, PersonRow
from rsc_brain.hunting.state_machine import HuntState, HuntType, check_transition, is_open
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope

HUNT_ANSWER_CREDIBILITY = 0.95
_EXPIRY = dt.timedelta(hours=72)
_HUNT_LOGICAL_ID = "__hunting__"


@dataclass(frozen=True, slots=True)
class HuntOutcome:
    hunt_id: str
    state: str
    person_id: str | None = None
    magic_token: str | None = None  # the plaintext link token, returned once (never stored)
    throttled: bool = False


def _pid(scope: ProjectScope) -> uuid.UUID:
    return uuid.UUID(scope.project_id)


class HuntService:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        channel: Channel | None = None,
        gateway: object | None = None,
        base_url: str = "https://brain.local",
        clock: Callable[[], dt.datetime] | None = None,
        max_open_per_person: int = 3,
        max_per_week: int = 5,
    ) -> None:
        self._sm = sessionmaker
        self._channel = channel or NullChannel()
        self._gateway = gateway
        self._directory = PersonDirectory(sessionmaker)
        self._base_url = base_url.rstrip("/")
        self._clock = clock or (lambda: dt.datetime.now(dt.UTC))
        self._max_open = max_open_per_person
        self._max_week = max_per_week

    # --- triggers ------------------------------------------------------------

    async def maybe_hunt_for_gap(
        self, scope: ProjectScope, gap_id: str, *, threshold: int = 3, window_days: int = 7
    ) -> HuntOutcome | None:
        """Trigger (a): a gap asked ≥threshold times in the window by HUMAN principals (agent gaps
        never count, FR-14.6). No-op if the threshold isn't met or a hunt is already open."""
        now = self._clock()
        since = now - dt.timedelta(days=window_days)
        async with self._sm() as session:
            gap = await session.get(models.Gap, uuid.UUID(gap_id))
            if gap is None or gap.project_id != _pid(scope):
                return None
            human_hits = await session.scalar(
                select(func.count())
                .select_from(models.AuditLog)
                .where(
                    models.AuditLog.project_id == _pid(scope),
                    models.AuditLog.action == "recall",
                    models.AuditLog.denied.is_(True),
                    models.AuditLog.query_hash == gap.query_hash,
                    models.AuditLog.principal_type == "human",
                    models.AuditLog.ts >= since,
                )
            )
            if int(human_hits or 0) < threshold:
                return None
            if await self._has_open_hunt_for_gap(session, gap.id):
                return None
            topics = tuple(gap.topics)
            question = gap.query_text or f"gap:{gap.query_hash}"
        return await self._open(
            scope, hunt_type=HuntType.GAP, question=question, topics=topics, gap_id=gap_id
        )

    async def create_manual(
        self, scope: ProjectScope, *, question: str, topics: Sequence[str]
    ) -> HuntOutcome:
        """Trigger (c): an admin opens a hunt by hand (`brain hunt ask`)."""
        return await self._open(
            scope, hunt_type=HuntType.MANUAL, question=question, topics=tuple(topics)
        )

    async def promote_agent_gap(self, scope: ProjectScope, gap_id: str) -> HuntOutcome | None:
        """Trigger (c): an admin promotes an agent gap to a hunt (it never triggers automatically)."""
        async with self._sm() as session:
            gap = await session.get(models.Gap, uuid.UUID(gap_id))
            if gap is None or gap.project_id != _pid(scope):
                return None
            question = gap.query_text or f"gap:{gap.query_hash}"
            topics = tuple(gap.topics)
        return await self._open(
            scope, hunt_type=HuntType.GAP, question=question, topics=topics, gap_id=gap_id
        )

    # --- lifecycle -----------------------------------------------------------

    async def _open(
        self,
        scope: ProjectScope,
        *,
        hunt_type: HuntType,
        question: str,
        topics: Sequence[str],
        gap_id: str | None = None,
        correction_id: str | None = None,
    ) -> HuntOutcome:
        person = await self._directory.route(scope, topics)
        now = self._clock()
        if person is None:
            hunt_id = await self._persist_no_owner(
                scope, hunt_type, question, gap_id, correction_id
            )
            await self._alert_admin(scope, f"hunt {hunt_id}: no owner for topics {list(topics)}")
            return HuntOutcome(hunt_id=hunt_id, state=HuntState.NO_OWNER, person_id=None)
        # Anti-spam (FR-6.5): don't open beyond the per-person / weekly caps.
        if await self._over_limit(scope, person.id, now):
            hunt_id = await self._persist_no_owner(
                scope, hunt_type, question, gap_id, correction_id, state=HuntState.ROUTED
            )
            return HuntOutcome(
                hunt_id=hunt_id, state=HuntState.ROUTED, person_id=person.id, throttled=True
            )
        token = security.mint_token("hunt_")
        quiet = _in_quiet_hours(person, now)
        async with session_scope(self._sm) as session:
            hunt = models.Hunt(
                project_id=_pid(scope),
                hunt_type=hunt_type.value,
                gap_id=uuid.UUID(gap_id) if gap_id else None,
                person_id=uuid.UUID(person.id),
                correction_id=uuid.UUID(correction_id) if correction_id else None,
                channel=_preferred_channel(person),
                state=HuntState.AWAITING_ANSWER.value,  # DETECTED→ROUTED→CONSENT_REQUESTED→AWAITING
                question=question,
                magic_token_hash=security.token_hash(token),
                consent_requested_at=now,
                asked_at=None if quiet else now,
                expires_at=now + _EXPIRY,
            )
            session.add(hunt)
            await session.flush()
            hunt_id = str(hunt.id)
        # A message is NEVER sent during quiet_hours — it waits for the next window (FR-6.5/3.4).
        if not quiet:
            await self._send_question(person, question, token)
        await self._audit(scope, "hunt_opened", person.id)
        return HuntOutcome(
            hunt_id=hunt_id, state=HuntState.AWAITING_ANSWER, person_id=person.id, magic_token=token
        )

    async def answer_via_magic_link(self, token: str, answer: str) -> HuntOutcome | None:
        """A person answers through the one-time link ⇒ a cred=0.95 claim + gap closed + RESOLVED.
        The token is single-use (cleared here), so a replay finds nothing."""
        now = self._clock()
        async with self._sm() as session:
            hunt = await session.scalar(
                select(models.Hunt).where(
                    models.Hunt.magic_token_hash == security.token_hash(token)
                )
            )
            if hunt is None or hunt.state != HuntState.AWAITING_ANSWER.value:
                return None
            if hunt.hunt_type == HuntType.CORRECTION_REVIEW.value:
                return None  # correction reviews resolve via corrections_review, not a free answer
            scope = _scope_from_hunt(hunt)
            gap_topics = await _gap_topics(session, hunt)
        claim_id = await self._ingest_answer(
            scope, hunt_id=str(hunt.id), text=answer, tags=gap_topics
        )
        async with session_scope(self._sm) as session:
            live = await session.get(models.Hunt, hunt.id)
            assert live is not None
            check_transition(HuntState.AWAITING_ANSWER, HuntState.ANSWERED)
            live.answer = answer
            live.answered_at = now
            live.claim_id = uuid.UUID(claim_id)
            live.magic_token_hash = None  # single-use
            live.state = HuntState.RESOLVED.value  # ANSWERED→INGESTED→RESOLVED (atomic here)
            live.resolved_at = now
            if live.gap_id is not None:
                gap = await session.get(models.Gap, live.gap_id)
                if gap is not None:
                    gap.status = "resolved"
        await self._audit(scope, "hunt_answered", str(hunt.person_id) if hunt.person_id else None)
        return HuntOutcome(hunt_id=str(hunt.id), state=HuntState.RESOLVED, person_id=None)

    async def decline_via_magic_link(self, token: str) -> HuntOutcome | None:
        now = self._clock()
        async with session_scope(self._sm) as session:
            hunt = await session.scalar(
                select(models.Hunt).where(
                    models.Hunt.magic_token_hash == security.token_hash(token)
                )
            )
            if hunt is None or hunt.state != HuntState.AWAITING_ANSWER.value:
                return None
            check_transition(HuntState.AWAITING_ANSWER, HuntState.DECLINED)
            hunt.state = HuntState.DECLINED.value
            hunt.magic_token_hash = None
            hunt.resolved_at = now
            return HuntOutcome(hunt_id=str(hunt.id), state=HuntState.DECLINED)

    async def expire_due(self, scope: ProjectScope) -> list[str]:
        """72h without an answer ⇒ one retry (resend), then escalate to admin (FR-6.3). Returns the
        hunt ids that changed. Idempotent per call; a scheduled job invokes this periodically."""
        now = self._clock()
        changed: list[str] = []
        async with self._sm() as session:
            due = (
                await session.scalars(
                    select(models.Hunt).where(
                        models.Hunt.project_id == _pid(scope),
                        models.Hunt.state == HuntState.AWAITING_ANSWER.value,
                        models.Hunt.expires_at < now,
                    )
                )
            ).all()
            ids = [str(h.id) for h in due]
        for hunt_id in ids:
            await self._expire_one(scope, hunt_id, now)
            changed.append(hunt_id)
        return changed

    async def _expire_one(self, scope: ProjectScope, hunt_id: str, now: dt.datetime) -> None:
        async with session_scope(self._sm) as session:
            hunt = await session.get(models.Hunt, uuid.UUID(hunt_id))
            if hunt is None or hunt.state != HuntState.AWAITING_ANSWER.value:
                return
            check_transition(HuntState.AWAITING_ANSWER, HuntState.EXPIRED)
            if hunt.retries < 1:
                # One retry: bounce EXPIRED→AWAITING_ANSWER with a fresh deadline (FR-6.3).
                hunt.retries += 1
                hunt.expires_at = now + _EXPIRY
                escalate = False
            else:
                hunt.state = HuntState.EXPIRED.value  # terminal after the retry
                hunt.resolved_at = now
                escalate = True
        if escalate:
            await self._alert_admin(scope, f"hunt {hunt_id} expired after retry — escalated")
            await self._audit(scope, "hunt_escalated", None)
        else:
            await self._audit(scope, "hunt_retried", None)

    # --- persistence helpers -------------------------------------------------

    async def _persist_no_owner(
        self,
        scope: ProjectScope,
        hunt_type: HuntType,
        question: str,
        gap_id: str | None,
        correction_id: str | None,
        *,
        state: HuntState = HuntState.NO_OWNER,
    ) -> str:
        now = self._clock()
        async with session_scope(self._sm) as session:
            hunt = models.Hunt(
                project_id=_pid(scope),
                hunt_type=hunt_type.value,
                gap_id=uuid.UUID(gap_id) if gap_id else None,
                correction_id=uuid.UUID(correction_id) if correction_id else None,
                state=state.value,
                question=question,
                created_at=now,
            )
            session.add(hunt)
            await session.flush()
            return str(hunt.id)

    async def _has_open_hunt_for_gap(self, session: AsyncSession, gap_id: uuid.UUID) -> bool:
        open_states = [s.value for s in HuntState if is_open(s)]
        existing = await session.scalar(
            select(models.Hunt.id).where(
                models.Hunt.gap_id == gap_id, models.Hunt.state.in_(open_states)
            )
        )
        return existing is not None

    async def _over_limit(self, scope: ProjectScope, person_id: str, now: dt.datetime) -> bool:
        open_states = [s.value for s in HuntState if is_open(s)]
        week_ago = now - dt.timedelta(days=7)
        async with self._sm() as session:
            open_count = await session.scalar(
                select(func.count())
                .select_from(models.Hunt)
                .where(
                    models.Hunt.project_id == _pid(scope),
                    models.Hunt.person_id == uuid.UUID(person_id),
                    models.Hunt.state.in_(open_states),
                )
            )
            week_count = await session.scalar(
                select(func.count())
                .select_from(models.Hunt)
                .where(
                    models.Hunt.project_id == _pid(scope),
                    models.Hunt.person_id == uuid.UUID(person_id),
                    models.Hunt.created_at >= week_ago,
                )
            )
        return int(open_count or 0) >= self._max_open or int(week_count or 0) >= self._max_week

    async def _ingest_answer(
        self, scope: ProjectScope, *, hunt_id: str, text: str, tags: Sequence[str]
    ) -> str:
        """Materialise the human answer as a chunk+claim (cred 0.95) under the synthetic hunting
        document, so it is recallable with maximum authority (E7.5)."""
        embedding = None
        if self._gateway is not None:
            embedding = list((await self._gateway.embed([text]))[0])  # type: ignore[attr-defined]
        async with session_scope(self._sm) as session:
            document_id = await self._hunt_document(session, scope)
            chunk = models.Chunk(
                project_id=_pid(scope),
                document_id=document_id,
                kind="prose",
                text=text,
                tags=list(tags),
                embedding=embedding,
                needs_review=False,
            )
            session.add(chunk)
            await session.flush()
            claim = models.Claim(
                project_id=_pid(scope),
                chunk_id=chunk.id,
                text=text,
                tags=list(tags),
                credibility=HUNT_ANSWER_CREDIBILITY,
                source_document_id=document_id,
                embedding=embedding,
            )
            session.add(claim)
            await session.flush()
            return str(claim.id)

    async def _hunt_document(self, session: AsyncSession, scope: ProjectScope) -> uuid.UUID:
        doc = await session.scalar(
            select(models.Document).where(
                models.Document.project_id == _pid(scope),
                models.Document.logical_id == _HUNT_LOGICAL_ID,
            )
        )
        if doc is not None:
            return doc.id
        created = models.Document(
            project_id=_pid(scope),
            logical_id=_HUNT_LOGICAL_ID,
            checksum=f"hunting:{scope.project_id}",
            title="Hunting answers",
            status="processed",
        )
        session.add(created)
        await session.flush()
        return created.id

    async def _send_question(self, person: PersonRow, question: str, token: str) -> None:
        link = f"{self._base_url}/hunt/{token}"
        to = str(person.channels.get("email") or person.channels.get("slack") or person.name)
        await self._channel.send(
            OutboundMessage(
                channel=_preferred_channel(person),
                to=to,
                subject="rsc-brain needs your knowledge",
                body=f"{question}\n\nAnswer here (one-time link): {link}",
                magic_link=link,
            )
        )

    async def _alert_admin(self, scope: ProjectScope, message: str) -> None:
        await self._channel.send(
            OutboundMessage(
                channel="admin", to="admin", subject="rsc-brain hunt alert", body=message
            )
        )

    async def _audit(self, scope: ProjectScope, action: str, person_id: str | None) -> None:
        await record_audit(self._sm, scope, action=action, tool="hunting", result_count=0)


def _preferred_channel(person: PersonRow) -> str:
    if person.channels.get("email"):
        return "email"
    if person.channels.get("slack"):
        return "slack"
    return "magic_link"


def _in_quiet_hours(person: PersonRow, now: dt.datetime) -> bool:
    """True if ``now`` (UTC) falls inside the person's quiet window ``{start,end}`` (HH:MM, UTC for
    v0.3; the reference tz is a documented open decision). Supports windows that wrap midnight."""
    qh = person.quiet_hours or {}
    start, end = qh.get("start"), qh.get("end")
    if not isinstance(start, str) or not isinstance(end, str):
        return False
    minute = now.hour * 60 + now.minute
    s = _hhmm(start)
    e = _hhmm(end)
    if s is None or e is None:
        return False
    if s <= e:
        return s <= minute < e
    return minute >= s or minute < e  # wraps midnight (e.g. 22:00-08:00)


def _hhmm(value: str) -> int | None:
    try:
        hh, mm = value.split(":")
        return int(hh) * 60 + int(mm)
    except (ValueError, AttributeError):
        return None


def _scope_from_hunt(hunt: models.Hunt) -> ProjectScope:
    from rsc_brain.scope import Principal, PrincipalType

    return Principal(
        id="11111111-1111-1111-1111-111111111111", type=PrincipalType.HUMAN, can_curate=True
    ).scope_for(str(hunt.project_id))


async def _gap_topics(session: AsyncSession, hunt: models.Hunt) -> tuple[str, ...]:
    if hunt.gap_id is None:
        return ()
    gap = await session.get(models.Gap, hunt.gap_id)
    return tuple(gap.topics) if gap is not None else ()
