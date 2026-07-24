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

from sqlalchemy import select
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
        doc = await session.scalar(
            select(models.Document).where(
                models.Document.project_id == _pid(scope),
                models.Document.logical_id == _SUBMISSION_LOGICAL_ID,
            )
        )
        if doc is not None:
            return doc.id
        created = models.Document(
            project_id=_pid(scope),
            logical_id=_SUBMISSION_LOGICAL_ID,
            checksum=f"agent-submissions:{scope.project_id}",
            title="Agent submissions",
            status="processed",
        )
        session.add(created)
        await session.flush()
        return created.id

    async def submit(
        self,
        scope: ProjectScope,
        *,
        text: str,
        idempotency_key: str,
        entities: list[str] | None = None,
        tags: list[str] | None = None,
    ) -> SubmitResult:
        principal = scope.principal_id
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
        embedding = (await self._gateway.embed([text]))[0]
        tag_list = list(tags or [])
        subject = entities[0] if entities else None

        async with session_scope(self._sm) as session:
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

        status = "quarantined" if quarantined else "active"
        await self._record(scope, idempotency_key, status, claim_ids)
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
