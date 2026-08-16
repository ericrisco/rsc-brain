"""Person directory + topic-overlap routing (SPEC-15, FR-6.1/6.3).

A ``Person`` is the responsible human for one or more topics in a project. Routing picks the person
whose ``topics`` overlap the gap/claim topics the most; no overlap ⇒ no owner (the caller raises
``NO_OWNER``). Everything is project-scoped in-query (FR-12.4).
"""

from __future__ import annotations

import builtins
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.sql.elements import ColumnElement
from sqlalchemy.sql.selectable import ScalarSelect

from rsc_brain.hunting.state_machine import HuntState, is_open
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope
from rsc_brain.visibility import forbidden_topics, topic_clause


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
    active_hunts: int = 0
    version: int = 1


class PersonVersionConflict(Exception):
    """The caller's optimistic-concurrency token no longer names the live person row."""


class PersonDependencyConflict(Exception):
    """A person with active hunts cannot be removed without first resolving the dependencies."""

    def __init__(self, active_hunts: int) -> None:
        self.active_hunts = active_hunts
        super().__init__("person has active hunts")


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

    async def list(self, scope: ProjectScope) -> builtins.list[PersonRow]:
        """Internal/CLI directory view; HTTP callers use :meth:`list_authorized`."""
        return await self._list(scope, authorize_topics=False)

    async def list_authorized(self, scope: ProjectScope) -> builtins.list[PersonRow]:
        """Directory rows filtered before collection counts or contact metadata are loaded."""
        return await self._list(scope, authorize_topics=True)

    async def _list(
        self, scope: ProjectScope, *, authorize_topics: bool
    ) -> builtins.list[PersonRow]:
        active_count = self._active_hunt_count()
        conditions: builtins.list[ColumnElement[bool]] = [models.Person.project_id == _pid(scope)]
        if authorize_topics:
            forbidden = await forbidden_topics(self._sm, scope)
            conditions.append(topic_clause(models.Person.topics, scope, forbidden))
        async with self._sm() as session:
            rows = await session.execute(
                select(models.Person, active_count.label("active_hunts"))
                .where(*conditions)
                .order_by(models.Person.name)
            )
            return [self._to_row(person, int(count or 0)) for person, count in rows]

    async def get(self, scope: ProjectScope, person_id: str) -> PersonRow | None:
        """Internal/CLI detail; HTTP callers use :meth:`get_authorized`."""
        return await self._get(scope, person_id, authorize_topics=False)

    async def get_authorized(self, scope: ProjectScope, person_id: str) -> PersonRow | None:
        return await self._get(scope, person_id, authorize_topics=True)

    async def _get(
        self, scope: ProjectScope, person_id: str, *, authorize_topics: bool
    ) -> PersonRow | None:
        try:
            person_uuid = uuid.UUID(person_id)
        except ValueError:
            return None
        active_count = self._active_hunt_count()
        conditions: builtins.list[ColumnElement[bool]] = [
            models.Person.id == person_uuid,
            models.Person.project_id == _pid(scope),
        ]
        if authorize_topics:
            forbidden = await forbidden_topics(self._sm, scope)
            conditions.append(topic_clause(models.Person.topics, scope, forbidden))
        async with self._sm() as session:
            row = (
                await session.execute(
                    select(models.Person, active_count.label("active_hunts")).where(*conditions)
                )
            ).one_or_none()
            if row is None:
                return None
            return self._to_row(row[0], int(row[1] or 0))

    async def update(
        self,
        scope: ProjectScope,
        person_id: str,
        *,
        topics: Sequence[str] | None = None,
        channels: Mapping[str, object] | None = None,
        quiet_hours: Mapping[str, object] | None = None,
        language: str | None = None,
        expected_version: int | None = None,
        authorize_topics: bool = False,
    ) -> PersonRow | None:
        values: dict[str, object] = {}
        if topics is not None:
            values["topics"] = list(topics)
        if channels is not None:
            values["channels"] = dict(channels)
        if quiet_hours is not None:
            values["quiet_hours"] = dict(quiet_hours)
        if language is not None:
            values["language"] = language
        try:
            person_uuid = uuid.UUID(person_id)
        except ValueError:
            return None
        conditions: builtins.list[ColumnElement[bool]] = [
            models.Person.id == person_uuid,
            models.Person.project_id == _pid(scope),
        ]
        if authorize_topics:
            forbidden = await forbidden_topics(self._sm, scope)
            conditions.append(topic_clause(models.Person.topics, scope, forbidden))
        async with session_scope(self._sm) as session:
            person = await session.scalar(
                select(models.Person).where(*conditions).with_for_update()
            )
            if person is None:
                return None
            if expected_version is not None and person.version != expected_version:
                raise PersonVersionConflict
            if values:
                for key, value in values.items():
                    setattr(person, key, value)
                person.version += 1
            await session.flush()
            return self._to_row(person, await self._count_active_hunts(session, person.id))

    async def remove(
        self,
        scope: ProjectScope,
        person_id: str,
        *,
        expected_version: int | None = None,
        authorize_topics: bool = False,
    ) -> bool:
        try:
            person_uuid = uuid.UUID(person_id)
        except ValueError:
            return False
        conditions: builtins.list[ColumnElement[bool]] = [
            models.Person.id == person_uuid,
            models.Person.project_id == _pid(scope),
        ]
        if authorize_topics:
            forbidden = await forbidden_topics(self._sm, scope)
            conditions.append(topic_clause(models.Person.topics, scope, forbidden))
        async with session_scope(self._sm) as session:
            person = await session.scalar(
                select(models.Person).where(*conditions).with_for_update()
            )
            if person is None:
                return False
            if expected_version is not None and person.version != expected_version:
                raise PersonVersionConflict
            active_hunts = await self._count_active_hunts(session, person.id)
            if active_hunts:
                raise PersonDependencyConflict(active_hunts)
            await session.delete(person)
            return True

    async def delete_impact(self, scope: ProjectScope, person_id: str) -> PersonRow | None:
        """Return the authoritative row and its current blocking dependency count."""
        return await self.get_authorized(scope, person_id)

    async def route(
        self, scope: ProjectScope, topics: Sequence[str], *, authorize_topics: bool = False
    ) -> PersonRow | None:
        """The person with the largest topic overlap with ``topics`` (FR-6.3). None ⇒ NO_OWNER."""
        wanted = {t for t in topics if t}
        if not wanted:
            return None
        candidates = (
            await self.list_authorized(scope) if authorize_topics else await self.list(scope)
        )
        best: PersonRow | None = None
        best_overlap = 0
        for person in candidates:
            overlap = len(wanted & set(person.topics))
            if overlap > best_overlap:
                best, best_overlap = person, overlap
        return best

    @staticmethod
    def _to_row(person: models.Person, active_hunts: int = 0) -> PersonRow:
        return PersonRow(
            id=str(person.id),
            name=person.name,
            channels=dict(person.channels or {}),
            topics=tuple(person.topics),
            quiet_hours=dict(person.quiet_hours or {}),
            language=person.language,
            active_hunts=active_hunts,
            version=person.version,
        )

    @staticmethod
    def _active_hunt_count() -> ScalarSelect[int]:
        open_states = [state.value for state in HuntState if is_open(state)]
        return (
            select(func.count())
            .select_from(models.Hunt)
            .where(
                models.Hunt.project_id == models.Person.project_id,
                models.Hunt.person_id == models.Person.id,
                models.Hunt.state.in_(open_states),
            )
            .correlate(models.Person)
            .scalar_subquery()
        )

    @staticmethod
    async def _count_active_hunts(session: AsyncSession, person_id: uuid.UUID) -> int:
        open_states = [state.value for state in HuntState if is_open(state)]
        count = await session.scalar(
            select(func.count())
            .select_from(models.Hunt)
            .where(models.Hunt.person_id == person_id, models.Hunt.state.in_(open_states))
        )
        return int(count or 0)
