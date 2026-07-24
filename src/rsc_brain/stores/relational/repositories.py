"""Repositories over the relational store.

Every **knowledge** repository method takes a :class:`~rsc_brain.scope.ProjectScope` as its
first argument and filters by ``scope.project_id`` *in the query* — a bare ``project_id`` is
never accepted (FR-12.4 / AUDIT-003; PR auto-reject surface). Forbidden and nonexistent are
indistinguishable to the caller (FR-4.3). Global repositories (users) are separate and are not
project-scoped.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope
from rsc_brain.stores.relational.repository import DocumentRef


def _pid(scope: ProjectScope) -> uuid.UUID:
    return uuid.UUID(scope.project_id)


@dataclass(frozen=True, slots=True)
class UserRef:
    user_id: str
    email: str


class KnowledgeRepository:
    """Project-scoped access to knowledge tables. Concrete impl of the frozen protocol."""

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sm = sessionmaker

    async def count_documents(self, scope: ProjectScope) -> int:
        async with self._sm() as session:
            total = await session.scalar(
                select(func.count())
                .select_from(models.Document)
                .where(models.Document.project_id == _pid(scope))
            )
            return int(total or 0)

    async def get_document(self, scope: ProjectScope, document_id: str) -> DocumentRef | None:
        async with self._sm() as session:
            doc = await session.get(models.Document, uuid.UUID(document_id))
            # Forbidden (wrong project) and nonexistent are indistinguishable (FR-4.3).
            if doc is None or doc.project_id != _pid(scope):
                return None
            return DocumentRef(document_id=str(doc.id), project_id=str(doc.project_id))

    async def list_documents(self, scope: ProjectScope) -> list[DocumentRef]:
        async with self._sm() as session:
            rows = await session.scalars(
                select(models.Document)
                .where(models.Document.project_id == _pid(scope))
                .order_by(models.Document.ingested_at)
            )
            return [DocumentRef(document_id=str(d.id), project_id=str(d.project_id)) for d in rows]

    async def create_document(
        self,
        scope: ProjectScope,
        *,
        logical_id: str,
        checksum: str,
        source_id: str | None = None,
        title: str | None = None,
        status: str = "received",
        doc_tags: Sequence[str] = (),
    ) -> DocumentRef:
        async with session_scope(self._sm) as session:
            doc = models.Document(
                project_id=_pid(scope),
                source_id=uuid.UUID(source_id) if source_id else None,
                logical_id=logical_id,
                checksum=checksum,
                title=title,
                status=status,
                doc_tags=list(doc_tags),
            )
            session.add(doc)
            await session.flush()
            return DocumentRef(document_id=str(doc.id), project_id=str(doc.project_id))

    async def add_chunk(
        self,
        scope: ProjectScope,
        *,
        document_id: str,
        text: str,
        kind: str = "prose",
        tags: Sequence[str] = (),
        embedding: Sequence[float] | None = None,
    ) -> str:
        async with session_scope(self._sm) as session:
            chunk = models.Chunk(
                project_id=_pid(scope),
                document_id=uuid.UUID(document_id),
                kind=kind,
                text=text,
                tags=list(tags),
                embedding=list(embedding) if embedding is not None else None,
            )
            session.add(chunk)
            await session.flush()
            return str(chunk.id)

    async def count_chunks(self, scope: ProjectScope) -> int:
        async with self._sm() as session:
            total = await session.scalar(
                select(func.count())
                .select_from(models.Chunk)
                .where(models.Chunk.project_id == _pid(scope))
            )
            return int(total or 0)


class UserRepository:
    """Global (non-project-scoped) identity repository."""

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sm = sessionmaker

    async def create_user(
        self,
        *,
        email: str,
        role: str = "member",
        status: str = "active",
        display_name: str | None = None,
    ) -> UserRef:
        async with session_scope(self._sm) as session:
            user = models.User(
                email=email, role=role, status=status, display_name=display_name
            )
            session.add(user)
            await session.flush()
            return UserRef(user_id=str(user.id), email=user.email)

    async def get_by_email(self, email: str) -> UserRef | None:
        async with self._sm() as session:
            user = await session.scalar(select(models.User).where(models.User.email == email))
            return UserRef(user_id=str(user.id), email=user.email) if user else None
