"""Ingest-time ontology seam (SPEC-24, FR-17.2/17.3/17.4). Off by default.

The pipeline holds an optional ``OntologyIngest``. When the project's ``ontology.enabled`` is false
(the default) every method here returns immediately without touching the DB or parsing anything, so
the ingest path is byte-for-byte the base pipeline. When enabled it: anchors entities to IRIs
(open-world — unanchored entities are left untouched), proposes alias merges for entities that land
on the same IRI (feeding the SPEC-09/21 review queue), and decides relation domain/range policy.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Literal

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.ontology.index import OntologyIndex
from rsc_brain.ontology.settings import OntologySettings, load_ontology_settings
from rsc_brain.review.states import PROPOSAL_AUTO_APPLIED
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope
from rsc_brain.stores.relational.entity_store import EntityStore

RelationVerdict = Literal["keep", "flag", "drop"]


class OntologyIngest:
    """Loads + caches active ontologies per project and applies the ingest-time layer."""

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sm = sessionmaker
        self._entities = EntityStore(sessionmaker)
        self._cache: dict[str, tuple[tuple[tuple[str, int], ...], OntologyIndex]] = {}

    async def settings_for(self, scope: ProjectScope) -> OntologySettings:
        return await load_ontology_settings(self._sm, scope)

    async def index_for(self, scope: ProjectScope) -> OntologyIndex | None:
        """The merged active-ontology index for the project, or None when disabled/absent. Cached
        by the active (id, version) fingerprint so back-to-back jobs never re-parse (SPEC-24 §4.2)."""
        settings = await self.settings_for(scope)
        if not settings.enabled:
            return None
        async with self._sm() as session:
            rows = list(
                await session.execute(
                    select(
                        models.Ontology.id,
                        models.Ontology.version,
                        models.Ontology.content,
                        models.Ontology.format,
                    ).where(
                        models.Ontology.project_id == _pid(scope),
                        models.Ontology.active.is_(True),
                    )
                )
            )
        if not rows:
            return None
        fingerprint = tuple(sorted((str(r[0]), int(r[1])) for r in rows))
        cached = self._cache.get(scope.project_id)
        if cached is not None and cached[0] == fingerprint:
            return cached[1]
        index = OntologyIndex.parse_many([(r[2], r[3]) for r in rows])
        self._cache[scope.project_id] = (fingerprint, index)
        return index

    def relation_decider(
        self, index: OntologyIndex | None, settings: OntologySettings
    ) -> Callable[[str, str, str], RelationVerdict] | None:
        """A per-relation policy function for FR-17.4, or None when the layer is off (so the
        pipeline skips the check entirely)."""
        if index is None:
            return None
        return build_relation_decider(index, settings)

    async def anchor_and_merge(self, scope: ProjectScope, index: OntologyIndex | None) -> None:
        """FR-17.2 anchoring + FR-17.3 assisted merge. No-op when the layer is off (index is None)."""
        if index is None:
            return
        settings = await self.settings_for(scope)
        by_iri = await self._anchor_entities(scope, index, settings)
        await self._propose_merges(scope, by_iri)

    async def _anchor_entities(
        self, scope: ProjectScope, index: OntologyIndex, settings: OntologySettings
    ) -> dict[str, list[str]]:
        """Anchor every still-unanchored live entity; return anchored entity ids grouped by IRI."""
        async with self._sm() as session:
            rows = list(
                await session.execute(
                    select(models.Entity.id, models.Entity.name).where(
                        models.Entity.project_id == _pid(scope),
                        models.Entity.merged_into.is_(None),
                        models.Entity.ontology_valid.is_(False),
                    )
                )
            )
        by_iri: dict[str, list[str]] = {}
        for entity_id, name in rows:
            iri = index.anchor(name, strategy=settings.strategy, threshold=settings.threshold)
            if iri is None:
                continue  # open-world: unanchored entities are kept exactly as-is
            canonical = _canonical_iri(index, iri)
            by_iri.setdefault(canonical, []).append(str(entity_id))
        for iri, ids in by_iri.items():
            async with session_scope(self._sm) as session:
                await session.execute(
                    update(models.Entity)
                    .where(models.Entity.id.in_([uuid.UUID(i) for i in ids]))
                    .values(ontology_uri=iri, ontology_valid=True)
                )
        return by_iri

    async def _propose_merges(self, scope: ProjectScope, by_iri: dict[str, list[str]]) -> None:
        """FR-17.3: entities that anchored to the same IRI are the same thing — propose a merge
        (auto-applied, high confidence: an exact shared IRI is strong evidence, cf. FR-1.9)."""
        for ids in by_iri.values():
            if len(ids) < 2:
                continue
            canonical, *duplicates = sorted(ids)
            for duplicate in duplicates:
                _proposal_id, created = await self._entities.create_proposal(
                    scope,
                    canonical_id=canonical,
                    duplicate_id=duplicate,
                    confidence=0.99,
                    method="ontology_sameas",
                    status=PROPOSAL_AUTO_APPLIED,
                    reason="shared ontology IRI (owl:sameAs / same anchor)",
                )
                if created:
                    await self._entities.apply_merge(
                        scope, canonical_id=canonical, duplicate_id=duplicate, confidence=0.99
                    )


def build_relation_decider(
    index: OntologyIndex, settings: OntologySettings
) -> Callable[[str, str, str], RelationVerdict]:
    """FR-17.4 domain/range policy as a pure function. Endpoints are anchored in-memory to test
    the property's domain/range; ``allow`` never checks, ``drop`` discards a violation, ``warn``
    (default) keeps it flagged for review."""
    policy = settings.relation_check

    def decide(predicate: str, subject: str, obj: str) -> RelationVerdict:
        if policy == "allow":
            return "keep"
        subject_iri = index.anchor(
            subject, strategy=settings.strategy, threshold=settings.threshold
        )
        object_iri = index.anchor(obj, strategy=settings.strategy, threshold=settings.threshold)
        if index.check_relation(predicate, subject_iri, object_iri):
            return "keep"
        return "drop" if policy == "drop" else "flag"

    return decide


def _canonical_iri(index: OntologyIndex, iri: str) -> str:
    """Fold ``owl:sameAs`` equivalents to a single representative (lexicographically smallest)."""
    return min({iri, *index.same_as(iri)})


def _pid(scope: ProjectScope) -> uuid.UUID:
    return uuid.UUID(scope.project_id)
