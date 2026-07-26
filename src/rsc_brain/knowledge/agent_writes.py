"""Agent knowledge writes — the ``submit_knowledge`` tool logic (SPEC-11, FR-14.4).

An agent (or human) submits a fact; it becomes a claim under the project's ``agent_writes`` policy:

* ``quarantine`` (default) — the claim's chunk is ``needs_review=True`` (authority 0.5), so it is
  **excluded from recall** by the same in-query gate as an unapproved document (D13, SPEC-05) until
  a human validates it (the console queue lands in SPEC-21);
* ``direct`` — active immediately, credibility clamped ``≤0.6`` (never authoritative);
* ``off`` — rejected for agents.

Writes are **idempotent**: a retry with the same ``(project, principal, idempotency_key)`` returns
the original claim ids without creating anything (agent retries never duplicate). Provenance
records the agent (and ``on_behalf_of`` via the scope). Submitted knowledge is materialised as a
chunk + claim under a per-project synthetic ``__agent_submissions__`` document, so it flows through
the exact recall path (embedding + tag visibility) as ingested content.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Literal

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.scope import PrincipalType, ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope

QUARANTINE_CREDIBILITY = 0.5
DIRECT_CREDIBILITY_CAP = 0.6
AGENT_SUBMISSION_LOGICAL_ID = "__agent_submissions__"
_SUBMISSION_LOGICAL_ID = AGENT_SUBMISSION_LOGICAL_ID  # backward-compatible alias

WritePolicy = Literal["quarantine", "direct", "off"]


@dataclass(frozen=True, slots=True)
class SubmitResult:
    status: str  # quarantined | active | rejected
    claim_ids: list[str] = field(default_factory=list)


def _pid(scope: ProjectScope) -> uuid.UUID:
    return uuid.UUID(scope.project_id)


class _KeyAlreadyClaimed(Exception):
    """Internal: another caller owns this idempotency key and its result is the answer (R32)."""


class AgentWriteService:
    def __init__(
        self, sessionmaker: async_sessionmaker[AsyncSession], gateway: ModelGateway
    ) -> None:
        self._sm = sessionmaker
        self._gateway = gateway

    async def _policy(self, session: AsyncSession, scope: ProjectScope) -> WritePolicy:
        settings = await session.scalar(
            select(models.Project.settings).where(models.Project.id == _pid(scope))
        )
        value = (settings or {}).get("agent_writes", "quarantine")
        return value if value in {"quarantine", "direct", "off"} else "quarantine"

    async def _synthetic_document(self, session: AsyncSession, scope: ProjectScope) -> uuid.UUID:
        """The project's one agent-submission document, created if absent — atomically (R32).

        This used to SELECT, decide, and INSERT, so two concurrent first submissions both decided to
        create it and the loser got a unique violation on the checksum: a raw ``IntegrityError`` out of
        an API whose whole contract is that a retry is safe.
        """
        insert = (
            pg_insert(models.Document)
            .values(
                project_id=_pid(scope),
                logical_id=_SUBMISSION_LOGICAL_ID,
                checksum=f"agent-submissions:{scope.project_id}",
                title="Agent submissions",
                status="processed",
            )
            .on_conflict_do_nothing(constraint="uq_documents_project_id_checksum")
            .returning(models.Document.id)
        )
        created = await session.scalar(insert)
        if created is not None:
            return created
        existing = await session.scalar(
            select(models.Document.id).where(
                models.Document.project_id == _pid(scope),
                models.Document.logical_id == _SUBMISSION_LOGICAL_ID,
            )
        )
        if existing is None:  # pragma: no cover - the ON CONFLICT proves the row is there
            raise RuntimeError("the agent-submission document vanished between insert and read")
        return existing

    async def submit(
        self,
        scope: ProjectScope,
        *,
        text: str,
        idempotency_key: str,
        entities: list[str] | None = None,
        tags: list[str] | None = None,
    ) -> SubmitResult:
        """Submit a fact once, however many times this is called with the same key (FR-14.4)."""
        try:
            return await self._submit_once(
                scope,
                text=text,
                idempotency_key=idempotency_key,
                entities=entities,
                tags=tags,
            )
        except _KeyAlreadyClaimed:
            # R32: the other caller's transaction has committed (its INSERT held the unique index until
            # it did), so this read returns its finished result — the whole point of an idempotency key.
            prior = await self._prior(scope, idempotency_key)
            if prior is None:  # pragma: no cover - the conflict proves the row exists
                return SubmitResult(status="rejected", claim_ids=[])
            return SubmitResult(status=prior.status, claim_ids=list(prior.claim_ids))

    async def _prior(
        self, scope: ProjectScope, idempotency_key: str
    ) -> models.AgentWriteIdempotency | None:
        async with self._sm() as session:
            row: models.AgentWriteIdempotency | None = await session.scalar(
                select(models.AgentWriteIdempotency).where(
                    models.AgentWriteIdempotency.project_id == _pid(scope),
                    models.AgentWriteIdempotency.principal_id == scope.principal_id,
                    models.AgentWriteIdempotency.idempotency_key == idempotency_key,
                )
            )
            return row

    async def _submit_once(
        self,
        scope: ProjectScope,
        *,
        text: str,
        idempotency_key: str,
        entities: list[str] | None = None,
        tags: list[str] | None = None,
    ) -> SubmitResult:
        principal = scope.principal_id
        # 0. Topic authority, BEFORE anything is persisted (R05). The tags a write carries decide
        # who will be able to read it, so a write may only ever carry topics the caller holds:
        #   * a tag outside `allowed_topics` — real or unregistered — is refused, not dropped or
        #     silently rewritten, because a dropped tag would publish the fact somewhere else;
        #   * a write with no tags has nothing to intersect and would land outside every topic's
        #     authority, so it is refused too;
        #   * empty topic authority is never "all topics".
        # This used to be absent entirely: `submit` persisted whatever tags it was handed.
        requested = [t for t in (tags or []) if t]
        if not requested or not set(requested) <= set(scope.allowed_topics):
            await self._record(scope, idempotency_key, "rejected", [])
            return SubmitResult(status="rejected", claim_ids=[])

        # 1. Idempotent replay — a retry with the same key returns the original result.
        async with self._sm() as session:
            prior = await session.scalar(
                select(models.AgentWriteIdempotency).where(
                    models.AgentWriteIdempotency.project_id == _pid(scope),
                    models.AgentWriteIdempotency.principal_id == principal,
                    models.AgentWriteIdempotency.idempotency_key == idempotency_key,
                )
            )
            if prior is not None:
                return SubmitResult(status=prior.status, claim_ids=list(prior.claim_ids))
            policy = await self._policy(session, scope)

        # 2. Policy gate: agents are refused entirely under `off`.
        if scope.principal_type is PrincipalType.AGENT and policy == "off":
            await self._record(scope, idempotency_key, "rejected", [])
            return SubmitResult(status="rejected", claim_ids=[])

        # An agent under `quarantine` writes needs_review claims (invisible to recall); a human, or
        # an agent under `direct`, writes an active claim (credibility capped ≤ 0.6).
        quarantined = scope.principal_type is PrincipalType.AGENT and policy == "quarantine"
        credibility = min(QUARANTINE_CREDIBILITY, DIRECT_CREDIBILITY_CAP)
        embedding = (await self._gateway.for_project(scope.project_id).embed([text]))[0]
        tag_list = list(tags or [])
        subject = entities[0] if entities else None
        status = "quarantined" if quarantined else "active"

        # R32: the ledger row is written FIRST and in the SAME transaction as the claim it describes.
        # It used to be written afterwards, so it could not claim the key: two retries of one
        # submission both found no prior row, both did the work, and the corpus got the same fact twice
        # under two ids — which then corroborated each other and raised the credibility of a single
        # assertion. Claiming the key first turns the second retry into a conflict; because the claim
        # and the ledger row commit together, the loser's re-read sees the winner's finished result
        # rather than a half-written one.
        async with session_scope(self._sm) as session:
            claimed = await session.scalar(
                pg_insert(models.AgentWriteIdempotency)
                .values(
                    project_id=_pid(scope),
                    principal_id=principal,
                    idempotency_key=idempotency_key,
                    claim_ids=[],
                    status=status,
                )
                .on_conflict_do_nothing(
                    index_elements=["project_id", "principal_id", "idempotency_key"]
                )
                .returning(models.AgentWriteIdempotency.id)
            )
            if claimed is None:
                # Another caller owns this key. Its INSERT blocked ours on the unique index until it
                # committed, so the row we read next is its final one.
                raise _KeyAlreadyClaimed
            document_id = await self._synthetic_document(session, scope)
            chunk = models.Chunk(
                project_id=_pid(scope),
                document_id=document_id,
                kind="prose",
                text=text,
                tags=tag_list,
                embedding=list(embedding),
                needs_review=quarantined,
            )
            session.add(chunk)
            await session.flush()
            claim = models.Claim(
                project_id=_pid(scope),
                chunk_id=chunk.id,
                text=text,
                subject=subject,
                tags=tag_list,
                credibility=credibility,
                source_document_id=document_id,
                embedding=list(embedding),
            )
            session.add(claim)
            await session.flush()
            claim_ids = [str(claim.id)]
            await session.execute(
                update(models.AgentWriteIdempotency)
                .where(
                    models.AgentWriteIdempotency.id == claimed,
                    models.AgentWriteIdempotency.project_id == _pid(scope),
                )
                .values(claim_ids=claim_ids)
            )
        return SubmitResult(status=status, claim_ids=claim_ids)

    async def _record(
        self, scope: ProjectScope, key: str, status: str, claim_ids: list[str]
    ) -> None:
        async with session_scope(self._sm) as session:
            await session.execute(
                pg_insert(models.AgentWriteIdempotency)
                .values(
                    project_id=_pid(scope),
                    principal_id=scope.principal_id,
                    idempotency_key=key,
                    claim_ids=claim_ids,
                    status=status,
                )
                .on_conflict_do_nothing(
                    index_elements=["project_id", "principal_id", "idempotency_key"]
                )
            )
