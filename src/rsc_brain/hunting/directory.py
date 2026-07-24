"""Person directory + topic-overlap routing (SPEC-15, FR-6.1/6.3).

A ``Person`` is the responsible human for one or more topics in a project. Routing picks the person
whose ``topics`` overlap the gap/claim topics the most; no overlap ⇒ no owner (the caller raises
``NO_OWNER``). Everything is project-scoped in-query (FR-12.4).
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope


def _pid(scope: ProjectScope) -> uuid.UUID:
    return uuid.UUID(scope.project_id)


@dataclass(frozen=True, slots=True)
class PersonRow:
    id: str
    name: str
    channels: dict[str, object]
    topics: tuple[str, ...]
    quiet_hours: dict[str, object] = field(default_factory=dict)
    language: str | None = None


class PersonDirectory:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sm = sessionmaker

    async def add(
        self,
        scope: ProjectScope,
        *,
        name: str,
        channels: Mapping[str, object] | None = None,
        topics: Sequence[str] = (),
        quiet_hours: Mapping[str, object] | None = None,
        language: str | None = None,
    ) -> str:
        async with session_scope(self._sm) as session:
            person = models.Person(
                project_id=_pid(scope),
                name=name,
                channels=dict(channels or {}),
                topics=list(topics),
                quiet_hours=dict(quiet_hours or {}),
                language=language,
            )
            session.add(person)
            await session.flush()
            return str(person.id)

    async def list(self, scope: ProjectScope) -> list[PersonRow]:
        async with self._sm() as session:
            rows = await session.scalars(
                select(models.Person)
                .where(models.Person.project_id == _pid(scope))
                .order_by(models.Person.name)
            )
            return [self._to_row(p) for p in rows]

    async def get(self, scope: ProjectScope, person_id: str) -> PersonRow | None:
        async with self._sm() as session:
            person = await session.get(models.Person, uuid.UUID(person_id))
            if person is None or person.project_id != _pid(scope):
                return None
            return self._to_row(person)

    async def update(
        self,
        scope: ProjectScope,
        person_id: str,
        *,
        topics: Sequence[str] | None = None,
        channels: Mapping[str, object] | None = None,
        quiet_hours: Mapping[str, object] | None = None,
        language: str | None = None,
    ) -> None:
        values: dict[str, object] = {}
        if topics is not None:
            values["topics"] = list(topics)
        if channels is not None:
            values["channels"] = dict(channels)
        if quiet_hours is not None:
            values["quiet_hours"] = dict(quiet_hours)
        if language is not None:
            values["language"] = language
        if not values:
            return
        async with session_scope(self._sm) as session:
            await session.execute(
                update(models.Person)
                .where(
                    models.Person.id == uuid.UUID(person_id),
                    models.Person.project_id == _pid(scope),
                )
                .values(**values)
            )

    async def remove(self, scope: ProjectScope, person_id: str) -> None:
        async with session_scope(self._sm) as session:
            await session.execute(
                delete(models.Person).where(
                    models.Person.id == uuid.UUID(person_id),
                    models.Person.project_id == _pid(scope),
                )
            )

    async def route(self, scope: ProjectScope, topics: Sequence[str]) -> PersonRow | None:
        """The person with the largest topic overlap with ``topics`` (FR-6.3). None ⇒ NO_OWNER."""
        wanted = {t for t in topics if t}
        if not wanted:
            return None
        candidates = await self.list(scope)
        best: PersonRow | None = None
        best_overlap = 0
        for person in candidates:
            overlap = len(wanted & set(person.topics))
            if overlap > best_overlap:
                best, best_overlap = person, overlap
        return best

    @staticmethod
    def _to_row(person: models.Person) -> PersonRow:
        return PersonRow(
            id=str(person.id),
            name=person.name,
            channels=dict(person.channels or {}),
            topics=tuple(person.topics),
            quiet_hours=dict(person.quiet_hours or {}),
            language=person.language,
        )
