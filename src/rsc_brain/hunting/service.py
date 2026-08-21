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
import hashlib
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from sqlalchemy import case, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain import security
from rsc_brain.audit import record_audit
from rsc_brain.hunting.channels import Channel, NullChannel, OutboundMessage
from rsc_brain.hunting.directory import PersonDirectory, PersonRow
from rsc_brain.hunting.quiet_hours import in_quiet_hours
from rsc_brain.hunting.state_machine import HuntState, HuntType, check_transition, is_open
from rsc_brain.scope import PROJECT_ROLE_ADMIN, ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope
from rsc_brain.visibility import forbidden_topics, topic_clause

HUNT_ANSWER_CREDIBILITY = 0.95
_EXPIRY = dt.timedelta(hours=72)
_HUNT_LOGICAL_ID = "__hunting__"
_OPEN_STATES = tuple(state for state in HuntState if is_open(state))


def _advisory_key(project_id: str, person_id: str) -> int:
    """A stable signed 64-bit key for ``pg_advisory_xact_lock`` per (project, person), so all
    concurrent opens for one person serialise and the anti-spam caps hold under concurrency."""
    digest = hashlib.sha256(f"{project_id}:{person_id}".encode()).digest()
    return int.from_bytes(digest[:8], "big", signed=True)


def _hunt_public(hunt: models.Hunt) -> dict[str, object]:
    """Serialise a hunt row for the CLI / admin API (never leaks the magic-token hash)."""
    return {
        "id": str(hunt.id),
        "type": hunt.hunt_type,
        "state": hunt.state,
        "question": hunt.question,
        "topics": list(hunt.topics or []),
        "person_id": str(hunt.person_id) if hunt.person_id else None,
        "gap_id": str(hunt.gap_id) if hunt.gap_id else None,
        "correction_id": str(hunt.correction_id) if hunt.correction_id else None,
        "channel": hunt.channel,
        "retries": hunt.retries,
        "created_at": hunt.created_at.isoformat() if hunt.created_at else None,
        "asked_at": hunt.asked_at.isoformat() if hunt.asked_at else None,
        "answered_at": hunt.answered_at.isoformat() if hunt.answered_at else None,
        "expires_at": hunt.expires_at.isoformat() if hunt.expires_at else None,
        "resolved_at": hunt.resolved_at.isoformat() if hunt.resolved_at else None,
    }


@dataclass(frozen=True, slots=True)
class HuntOutcome:
    hunt_id: str
    state: str
    person_id: str | None = None
    magic_token: str | None = None  # the plaintext link token, returned once (never stored)
    throttled: bool = False
    #: Whether a message actually went out. False for a throttled, quiet-hours or undelivered hunt.
    delivered: bool = True
    topics: tuple[str, ...] = ()
    audit_correlation: str | None = None
    replayed: bool = False


def _is_sent(throttled: bool, quiet: bool, can_deliver: bool) -> bool:
    """Whether opening the hunt actually put a message in front of a person."""
    return can_deliver and not throttled and not quiet


def _open_state(*, throttled: bool, quiet: bool, can_deliver: bool) -> HuntState:
    """The state an opened hunt starts in.

    ROUTED covers both "parked by a cap" and "this install cannot deliver"; SCHEDULED covers "waiting
    for the quiet-hours window to close" — the state existed for exactly that and was never used, so a
    hunt held back by quiet hours claimed to be awaiting an answer.
    """
    if throttled or not can_deliver:
        return HuntState.ROUTED
    return HuntState.SCHEDULED if quiet else HuntState.AWAITING_ANSWER


def _pid(scope: ProjectScope) -> uuid.UUID:
    return uuid.UUID(scope.project_id)


class HuntService:
    #: Used only when no origin is configured. Kept as a named constant so a link built from it is
    #: recognisable as "this install never said how it is reached" instead of looking deliberate.
    UNCONFIGURED_BASE_URL = "https://brain.local"

    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        channel: Channel | None = None,
        gateway: object | None = None,
        base_url: str = UNCONFIGURED_BASE_URL,
        clock: Callable[[], dt.datetime] | None = None,
        max_open_per_person: int = 3,
        max_per_week: int = 5,
        # R28: whether the channel can actually reach a person. ``None`` means "infer": a caller that
        # SUPPLIED a channel intends to deliver through it, and the only way to get no channel is to
        # pass none, which is what an unconfigured install does. An undelivered hunt is then reported
        # as such instead of claiming somebody is awaiting an answer.
        can_deliver: bool | None = None,
    ) -> None:
        self._sm = sessionmaker
        self._channel = channel or NullChannel()
        self._gateway = gateway
        self._directory = PersonDirectory(sessionmaker)
        self._base_url = base_url.rstrip("/")
        self._clock = clock or (lambda: dt.datetime.now(dt.UTC))
        self._max_open = max_open_per_person
        self._max_week = max_per_week
        self._can_deliver = channel is not None if can_deliver is None else can_deliver

    @property
    def channel(self) -> Channel:
        """The channel this install delivers through (public: operators need to see it)."""
        return self._channel

    @property
    def can_deliver(self) -> bool:
        return self._can_deliver

    def answer_url(self, token: str) -> str:
        """The one-time reply link. Single definition, shared with the route that serves it."""
        return f"{self._base_url}/hunt/{token}"

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
        self,
        scope: ProjectScope,
        *,
        question: str,
        topics: Sequence[str],
        idempotency_key: str | None = None,
        authorize_directory: bool = False,
    ) -> HuntOutcome:
        """Trigger (c): an admin opens a hunt by hand (`brain hunt ask`)."""
        hunt_id = (
            uuid.uuid5(
                uuid.UUID(scope.project_id),
                f"manual-hunt:{scope.principal_id}:{idempotency_key}",
            )
            if idempotency_key
            else None
        )
        audit_correlation = str(
            uuid.uuid5(
                uuid.UUID(scope.project_id),
                f"manual-hunt-audit:{scope.principal_id}:{idempotency_key}",
            )
            if idempotency_key
            else uuid.uuid4()
        )
        return await self._open(
            scope,
            hunt_type=HuntType.MANUAL,
            question=question,
            topics=tuple(topics),
            command_hunt_id=hunt_id,
            audit_correlation=audit_correlation,
            authorize_directory=authorize_directory,
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

    # --- read models (CLI / admin API, FR-6.6 partial) -----------------------

    async def list_hunts(
        self, scope: ProjectScope, *, open_only: bool = False, limit: int = 100
    ) -> list[dict[str, object]]:
        """The project's hunts, newest first, filtered on the persisted topic snapshot."""
        forbidden = await forbidden_topics(self._sm, scope)
        effective_topics = case(
            (func.cardinality(models.Hunt.topics) > 0, models.Hunt.topics),
            else_=func.coalesce(models.Gap.topics, models.Hunt.topics),
        )
        query = (
            select(models.Hunt)
            .outerjoin(
                models.Gap,
                (models.Hunt.gap_id == models.Gap.id)
                & (models.Hunt.project_id == models.Gap.project_id),
            )
            .where(
                models.Hunt.project_id == _pid(scope),
                topic_clause(
                    effective_topics,
                    scope,
                    forbidden,
                    # An empty snapshot means its legacy writer supplied no recoverable topic.
                    # Only a project administrator may inspect that legacy record.
                    allow_untagged=scope.role == PROJECT_ROLE_ADMIN,
                ),
            )
            .order_by(models.Hunt.created_at.desc())
            .limit(limit)
        )
        if open_only:
            query = query.where(models.Hunt.state.in_([s.value for s in _OPEN_STATES]))
        async with self._sm() as session:
            rows = await session.scalars(query)
            return [_hunt_public(hunt) for hunt in rows]

    async def get_hunt(self, scope: ProjectScope, hunt_id: str) -> dict[str, object] | None:
        """One hunt, or ``None`` when absent or outside the caller's topic visibility (R01/FR-4.3)."""
        try:
            hunt_uuid = uuid.UUID(hunt_id)
        except ValueError:
            return None
        forbidden = await forbidden_topics(self._sm, scope)
        effective_topics = case(
            (func.cardinality(models.Hunt.topics) > 0, models.Hunt.topics),
            else_=func.coalesce(models.Gap.topics, models.Hunt.topics),
        )
        async with self._sm() as session:
            hunt = await session.scalar(
                select(models.Hunt)
                .outerjoin(
                    models.Gap,
                    (models.Hunt.gap_id == models.Gap.id)
                    & (models.Hunt.project_id == models.Gap.project_id),
                )
                .where(
                    models.Hunt.id == hunt_uuid,
                    models.Hunt.project_id == _pid(scope),
                    topic_clause(
                        effective_topics,
                        scope,
                        forbidden,
                        allow_untagged=scope.role == PROJECT_ROLE_ADMIN,
                    ),
                )
            )
            if hunt is None:
                return None
            return _hunt_public(hunt)

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
        command_hunt_id: uuid.UUID | None = None,
        audit_correlation: str | None = None,
        authorize_directory: bool = False,
    ) -> HuntOutcome:
        topic_snapshot = tuple(dict.fromkeys(topic for topic in topics if topic))
        correlation = audit_correlation or str(uuid.uuid4())
        person = await self._directory.route(scope, topics, authorize_topics=authorize_directory)
        now = self._clock()
        token = security.mint_token("hunt_")
        quiet = in_quiet_hours(person, now) if person is not None else False
        throttled = False
        async with session_scope(self._sm) as session:
            if command_hunt_id is not None:
                # The id is a UUIDv5 of project + principal + idempotency key.  The advisory lock
                # makes concurrent retries serialize before either can deliver; the persisted id
                # makes the replay survive an application restart without another schema object.
                await session.execute(
                    text("SELECT pg_advisory_xact_lock(:key)"),
                    {"key": _advisory_key(scope.project_id, str(command_hunt_id))},
                )
                existing = await session.scalar(
                    select(models.Hunt).where(
                        models.Hunt.id == command_hunt_id,
                        models.Hunt.project_id == _pid(scope),
                    )
                )
                if existing is not None:
                    return HuntOutcome(
                        hunt_id=str(existing.id),
                        state=existing.state,
                        person_id=str(existing.person_id) if existing.person_id else None,
                        throttled=(existing.state == HuntState.ROUTED.value and self._can_deliver),
                        delivered=existing.asked_at is not None,
                        topics=tuple(existing.topics or []),
                        audit_correlation=correlation,
                        replayed=True,
                    )

            if person is None:
                hunt = models.Hunt(
                    project_id=_pid(scope),
                    hunt_type=hunt_type.value,
                    gap_id=uuid.UUID(gap_id) if gap_id else None,
                    correction_id=uuid.UUID(correction_id) if correction_id else None,
                    state=HuntState.NO_OWNER.value,
                    question=question,
                    topics=list(topic_snapshot),
                    created_at=now,
                )
                if command_hunt_id is not None:
                    hunt.id = command_hunt_id
                session.add(hunt)
                await session.flush()
                hunt_id = str(hunt.id)
            else:
                # Serialise all concurrent opens for this person, then check the caps in the SAME
                # transaction as the insert — so 3 open / 5 per week hold even under concurrent
                # creation (FR-6.5, AC#7); a throttled hunt is parked ROUTED and never sent (§7.1).
                await self._lock_person(session, scope, person.id)
                throttled = await self._over_limit(session, scope, person.id, now)
                hunt = models.Hunt(
                    project_id=_pid(scope),
                    hunt_type=hunt_type.value,
                    gap_id=uuid.UUID(gap_id) if gap_id else None,
                    person_id=uuid.UUID(person.id),
                    correction_id=uuid.UUID(correction_id) if correction_id else None,
                    channel=_preferred_channel(person),
                    state=_open_state(
                        throttled=throttled, quiet=quiet, can_deliver=self._can_deliver
                    ).value,
                    question=question,
                    topics=list(topic_snapshot),
                    # The token and the 72h deadline belong to the DELIVERY, not to the row: a hunt
                    # held for quiet hours/caps stores no live credential nobody received.
                    magic_token_hash=(
                        security.token_hash(token)
                        if _is_sent(throttled, quiet, self._can_deliver)
                        else None
                    ),
                    consent_requested_at=now,
                    asked_at=now if _is_sent(throttled, quiet, self._can_deliver) else None,
                    expires_at=(
                        now + _EXPIRY if _is_sent(throttled, quiet, self._can_deliver) else None
                    ),
                    created_at=now,
                )
                if command_hunt_id is not None:
                    hunt.id = command_hunt_id
                session.add(hunt)
                await session.flush()
                hunt_id = str(hunt.id)

        if person is None:
            await self._alert_admin(
                scope, f"hunt {hunt_id}: no owner for topics {list(topic_snapshot)}"
            )
            await self._audit(
                scope,
                "hunt_no_owner",
                None,
                trace_id=correlation,
                topics=topic_snapshot,
            )
            return HuntOutcome(
                hunt_id=hunt_id,
                state=HuntState.NO_OWNER,
                person_id=None,
                topics=topic_snapshot,
                audit_correlation=correlation,
            )
        if throttled:
            await self._audit(
                scope,
                "hunt_throttled",
                person.id,
                trace_id=correlation,
                topics=topic_snapshot,
            )
            return HuntOutcome(
                hunt_id=hunt_id,
                state=HuntState.ROUTED,
                person_id=person.id,
                throttled=True,
                delivered=False,
                topics=topic_snapshot,
                audit_correlation=correlation,
            )
        if not self._can_deliver:
            # R28: nothing was sent and nobody was asked. Saying AWAITING_ANSWER here is what made an
            # unconfigured install look identical to a working one, with the gap left open behind a
            # record claiming somebody had been contacted.
            await self._audit(
                scope,
                "hunt_undelivered",
                person.id,
                trace_id=correlation,
                topics=topic_snapshot,
            )
            return HuntOutcome(
                hunt_id=hunt_id,
                state=HuntState.ROUTED,
                person_id=person.id,
                delivered=False,
                topics=topic_snapshot,
                audit_correlation=correlation,
            )
        # A message is NEVER sent during quiet_hours — it waits for the next window (FR-6.5/3.4).
        if not quiet:
            await self._send_question(person, question, token)
        await self._audit(
            scope,
            "hunt_opened",
            person.id,
            trace_id=correlation,
            topics=topic_snapshot,
        )
        return HuntOutcome(
            hunt_id=hunt_id,
            state=HuntState.SCHEDULED if quiet else HuntState.AWAITING_ANSWER,
            person_id=person.id,
            magic_token=token,
            delivered=not quiet,
            topics=topic_snapshot,
            audit_correlation=correlation,
        )

    async def _lock_person(
        self, session: AsyncSession, scope: ProjectScope, person_id: str
    ) -> None:
        await session.execute(
            text("SELECT pg_advisory_xact_lock(:key)"),
            {"key": _advisory_key(scope.project_id, person_id)},
        )

    async def hunt_for_token(self, token: str) -> dict[str, object] | None:
        """The hunt a magic-link token opens, or ``None`` for anything that cannot be answered.

        Deliberately narrow: it returns the question and nothing else, and it does not distinguish
        "unknown token" from "already answered" or "expired" — the reply form is unauthenticated, so a
        differentiated answer here would let anyone probe which tokens exist (FR-4.3's reasoning applied
        to a public surface).
        """
        async with self._sm() as session:
            hunt = await session.scalar(
                select(models.Hunt).where(
                    models.Hunt.magic_token_hash == security.token_hash(token)
                )
            )
            if hunt is None or hunt.state != HuntState.AWAITING_ANSWER.value:
                return None
            expires = hunt.expires_at
            if expires is not None and expires <= self._clock():
                return None
            return {"hunt_id": str(hunt.id), "question": hunt.question}

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
            if live is None:  # pragma: no cover - read moments ago in this same request
                raise RuntimeError(f"hunt {hunt.id} disappeared mid-answer")
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

    async def send_scheduled(self, scope: ProjectScope) -> list[str]:
        """Deliver hunts parked for quiet hours whose window has now closed (FR-6.5/3.4).

        The documented machine has always read ``CONSENT_REQUESTED → [SCHEDULED →] AWAITING_ANSWER``
        and nothing implemented the middle step: a hunt held back by quiet hours was recorded as
        awaiting an answer, so the 72h clock ran on a question nobody had been asked and the person got
        no message at all (R28). Returns the hunt ids delivered; a scheduled job calls this the way it
        calls :meth:`expire_due`.

        The message goes out BEFORE the row is moved to ``AWAITING_ANSWER``: a crash in between resends
        a duplicate reminder, which is recoverable, whereas the reverse order leaves a hunt claiming to
        have asked someone who was never contacted — the failure this finding is about.
        """
        if not self._can_deliver:
            return []
        now = self._clock()
        delivered: list[str] = []
        async with self._sm() as session:
            parked = (
                await session.scalars(
                    select(models.Hunt).where(
                        models.Hunt.project_id == _pid(scope),
                        models.Hunt.state == HuntState.SCHEDULED.value,
                    )
                )
            ).all()
            pending = [
                (str(h.id), str(h.person_id), h.question or "") for h in parked if h.person_id
            ]
        for hunt_id, person_id, question in pending:
            person = await self._directory.get(scope, person_id)
            if person is None or in_quiet_hours(person, now):
                continue
            token = security.mint_token("hunt_")
            await self._send_question(person, question, token)
            async with session_scope(self._sm) as session:
                hunt = await session.get(models.Hunt, uuid.UUID(hunt_id))
                if hunt is None or hunt.state != HuntState.SCHEDULED.value:
                    continue  # someone else delivered or resolved it; the duplicate send is harmless
                check_transition(HuntState.SCHEDULED, HuntState.AWAITING_ANSWER)
                hunt.state = HuntState.AWAITING_ANSWER.value
                hunt.magic_token_hash = security.token_hash(token)
                hunt.asked_at = now
                hunt.expires_at = now + _EXPIRY
            await self._audit(scope, "hunt_opened", person_id)
            delivered.append(hunt_id)
        return delivered

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

    async def _over_limit(
        self, session: AsyncSession, scope: ProjectScope, person_id: str, now: dt.datetime
    ) -> bool:
        """Count this person's open + weekly hunts against the caps. Runs on the caller's locked
        transaction (see :meth:`_lock_person`) so the read is consistent with the pending insert."""
        open_states = [s.value for s in HuntState if is_open(s)]
        week_ago = now - dt.timedelta(days=7)
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
            gateway = self._gateway.for_project(scope.project_id)  # type: ignore[attr-defined]
            embedding = list((await gateway.embed([text]))[0])
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
            from rsc_brain.skills.staleness import mark_tags_and_entities_stale_in_session

            await mark_tags_and_entities_stale_in_session(
                session,
                scope,
                tags=tags,
                reason="accepted hunting knowledge",
            )
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
        link = self.answer_url(token)
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

    async def _audit(
        self,
        scope: ProjectScope,
        action: str,
        person_id: str | None,
        *,
        trace_id: str | None = None,
        topics: Sequence[str] = (),
    ) -> None:
        del person_id  # retained in the internal contract for channel/audit attribution expansion
        await record_audit(
            self._sm,
            scope,
            action=action,
            tool="hunting",
            result_count=0,
            trace_id=trace_id,
            topics_used=topics,
        )


def _preferred_channel(person: PersonRow) -> str:
    if person.channels.get("email"):
        return "email"
    if person.channels.get("slack"):
        return "slack"
    return "magic_link"


def _scope_from_hunt(hunt: models.Hunt) -> ProjectScope:
    from rsc_brain.scope import Principal, PrincipalType

    return Principal(
        id="11111111-1111-1111-1111-111111111111", type=PrincipalType.HUMAN, can_curate=True
    ).scope_for(str(hunt.project_id))


async def _gap_topics(session: AsyncSession, hunt: models.Hunt) -> tuple[str, ...]:
    if hunt.topics:
        return tuple(hunt.topics)
    if hunt.gap_id is None:
        return ()
    gap = await session.get(models.Gap, hunt.gap_id)
    return tuple(gap.topics) if gap is not None else ()
