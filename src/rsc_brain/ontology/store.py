"""Ontology persistence + entity anchoring + coverage (SPEC-24, FR-17.1/2/7). Project-scoped."""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.ontology.index import OntologyIndex
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope


def _pid(scope: ProjectScope) -> uuid.UUID:
    return uuid.UUID(scope.project_id)


@dataclass(frozen=True, slots=True)
class OntologyRow:
    id: str
    name: str
    format: str
    version: int
    active: bool
    triples: int


class OntologyStore:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sm = sessionmaker

    async def add(
        self, scope: ProjectScope, *, name: str, content: str, fmt: str, uri_base: str | None = None
    ) -> str:
        """Add an ontology (validates by parsing first). A new upload of the same ``name`` bumps the
        version and becomes the active one; prior versions stay queryable but inactive."""
        OntologyIndex.parse(content, fmt)  # validate syntax; raises OntologyParseError
        pid = _pid(scope)
        async with session_scope(self._sm) as session:
            prior_max = await session.scalar(
                select(func.max(models.Ontology.version)).where(
                    models.Ontology.project_id == pid, models.Ontology.name == name
                )
            )
            await session.execute(
                update(models.Ontology)
                .where(models.Ontology.project_id == pid, models.Ontology.name == name)
                .values(active=False)
            )
            ontology = models.Ontology(
                project_id=pid,
                name=name,
                format=fmt,
                version=int(prior_max or 0) + 1,
                uri_base=uri_base,
                content=content,
                active=True,
            )
            session.add(ontology)
            await session.flush()
            return str(ontology.id)

    async def list_all(self, scope: ProjectScope) -> list[OntologyRow]:
        async with self._sm() as session:
            rows = await session.scalars(
                select(models.Ontology)
                .where(models.Ontology.project_id == _pid(scope))
                .order_by(models.Ontology.name, models.Ontology.version.desc())
            )
            return [
                OntologyRow(
                    id=str(o.id),
                    name=o.name,
                    format=o.format,
                    version=o.version,
                    active=o.active,
                    triples=OntologyIndex.parse(o.content, o.format).triples,
                )
                for o in rows
            ]

    async def active_index(self, scope: ProjectScope) -> OntologyIndex | None:
        """The merged index of the project's active ontologies (None if there are none)."""
        async with self._sm() as session:
            docs = list(
                await session.execute(
                    select(models.Ontology.content, models.Ontology.format).where(
                        models.Ontology.project_id == _pid(scope), models.Ontology.active.is_(True)
                    )
                )
            )
        if not docs:
            return None
        return OntologyIndex.parse_many([(content, fmt) for content, fmt in docs])

    async def set_entity_anchor(self, scope: ProjectScope, entity_id: str, iri: str) -> None:
        async with session_scope(self._sm) as session:
            await session.execute(
                update(models.Entity)
                .where(
                    models.Entity.id == uuid.UUID(entity_id),
                    models.Entity.project_id == _pid(scope),
                )
                .values(ontology_uri=iri, ontology_valid=True)
            )

    async def coverage(self, scope: ProjectScope, *, top_n: int = 10) -> dict[str, object]:
        """% of entities anchored + the top unanchored names (FR-17.7)."""
        pid = _pid(scope)
        async with self._sm() as session:
            total = int(
                await session.scalar(
                    select(func.count())
                    .select_from(models.Entity)
                    .where(models.Entity.project_id == pid)
                )
                or 0
            )
            anchored = int(
                await session.scalar(
                    select(func.count())
                    .select_from(models.Entity)
                    .where(models.Entity.project_id == pid, models.Entity.ontology_valid.is_(True))
                )
                or 0
            )
            unanchored = list(
                await session.scalars(
                    select(models.Entity.name)
                    .where(models.Entity.project_id == pid, models.Entity.ontology_valid.is_(False))
                    .order_by(models.Entity.name)
                    .limit(top_n)
                )
            )
        return {
            "total": total,
            "anchored": anchored,
            "coverage": round(anchored / total, 3) if total else 0.0,
            "top_unanchored": unanchored,
        }
