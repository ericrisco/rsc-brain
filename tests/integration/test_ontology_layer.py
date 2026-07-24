"""The ontology layer end-to-end against real Postgres+AGE (SPEC-24): anchoring (FR-17.2), assisted
merge (FR-17.3), bounded recall expansion (FR-17.5), the FR-17.8 permission rule, and off=inert."""

from __future__ import annotations

import uuid
from collections.abc import Callable

import pytest
from sqlalchemy import func, select

from rsc_brain.config.models import RecallConfig
from rsc_brain.ontology.recall import OntologyRecall
from rsc_brain.ontology.store import OntologyStore
from rsc_brain.recall.permissions import sensitive_tags
from rsc_brain.recall.retriever import PgRetriever
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational import models
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

ONTOLOGY = """
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix ex: <http://example.org/legal#> .
ex:Contract a owl:Class ; rdfs:label "contract" .
ex:Lease a owl:Class ; rdfs:label "lease" ; rdfs:subClassOf ex:Contract .
ex:Sale a owl:Class ; rdfs:label "sale" ; rdfs:subClassOf ex:Contract .
ex:MI a skos:Concept ; skos:prefLabel "myocardial infarction" .
ex:AMI a skos:Concept ; skos:prefLabel "acute myocardial infarction" ; owl:sameAs ex:MI .
"""


async def _enable_ontology(harness: Harness, project_id: str, *, strategy: str = "exact") -> None:
    await OntologyStore(harness.sm).add(
        harness.scope(project_id), name="onto", content=ONTOLOGY, fmt="turtle"
    )
    async with harness.sm() as session:
        project = await session.get(models.Project, uuid.UUID(project_id))
        assert project is not None
        project.settings = {
            **(project.settings or {}),
            "ontology": {"enabled": True, "strategy": strategy, "inference_depth": 1},
        }
        await session.commit()


async def _publish(harness: Harness, project_id: str, doc: bytes, *, tags: list[str]) -> str:
    scope = harness.scope(project_id, allowed_topics=tags)
    await harness.repo.create_source(
        scope, name="src", type_="folder", policy="source_tags", default_tags=tags
    )
    outcome = await harness.service.ingest_bytes(scope, doc, filename="d.md", source="src")
    return outcome.document_id


async def _entity_by_name(harness: Harness, project_id: str, name: str) -> models.Entity | None:
    async with harness.sm() as session:
        entity: models.Entity | None = await session.scalar(
            select(models.Entity).where(
                models.Entity.project_id == uuid.UUID(project_id), models.Entity.name == name
            )
        )
        return entity


# --- FR-17.2 anchoring (open-world) -----------------------------------------


async def test_anchoring_sets_uri_and_leaves_unanchored_local(
    build_harness: Callable[..., Harness],
    make_completion: Callable[..., object],
) -> None:
    harness = build_harness(
        with_ontology=True,
        completion=make_completion(
            entities=[
                {"name": "lease", "type": "thing", "aliases": []},
                {"name": "widget", "type": "thing", "aliases": []},
            ],
            tags=["legal"],
        ),
    )
    project = await harness.setup_project(unique_slug("legalco"), [("legal", 0)])
    await _enable_ontology(harness, project)
    await _publish(
        harness, project, b"# Doc\n\nThe lease and the widget are recorded here.\n", tags=["legal"]
    )

    lease = await _entity_by_name(harness, project, "lease")
    widget = await _entity_by_name(harness, project, "widget")
    assert lease is not None and lease.ontology_valid is True
    assert lease.ontology_uri == "http://example.org/legal#Lease"
    # Open-world: an entity outside the ontology persists untouched (FR-17.2, CA#3).
    assert widget is not None and widget.ontology_valid is False
    assert widget.ontology_uri is None


# --- FR-17.3 assisted merge (owl:sameAs) ------------------------------------


async def test_sameas_entities_are_merged(
    build_harness: Callable[..., Harness],
    make_completion: Callable[..., object],
) -> None:
    harness = build_harness(
        with_ontology=True,
        completion=make_completion(
            entities=[
                {"name": "myocardial infarction", "type": "condition", "aliases": []},
                {"name": "acute myocardial infarction", "type": "condition", "aliases": []},
            ],
            tags=["legal"],
        ),
    )
    project = await harness.setup_project(unique_slug("medco"), [("legal", 0)])
    await _enable_ontology(harness, project)
    await _publish(
        harness,
        project,
        b"# Doc\n\nA myocardial infarction (acute myocardial infarction).\n",
        tags=["legal"],
    )

    async with harness.sm() as session:
        live = await session.scalar(
            select(func.count())
            .select_from(models.Entity)
            .where(
                models.Entity.project_id == uuid.UUID(project),
                models.Entity.merged_into.is_(None),
            )
        )
        merged = await session.scalar(
            select(func.count())
            .select_from(models.Entity)
            .where(
                models.Entity.project_id == uuid.UUID(project),
                models.Entity.merged_into.is_not(None),
            )
        )
    # The two synonyms share an IRI (owl:sameAs) ⇒ one folds into the other (U24).
    assert live == 1
    assert merged == 1


# --- FR-17.5 bounded recall expansion ---------------------------------------


def _retriever(harness: Harness, *, with_ontology: bool) -> PgRetriever:
    return PgRetriever(
        sessionmaker=harness.sm,
        gateway=harness.gateway,
        graph_store=AgeGraphStore(harness.sm),
        config=RecallConfig(),
        ontology=OntologyRecall(harness.sm) if with_ontology else None,
    )


async def test_expand_query_labels_reaches_subclasses(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("legalco"), [("legal", 0)])
    await _enable_ontology(harness, project)
    scope = harness.scope(project, allowed_topics=["legal"])
    labels = await OntologyRecall(harness.sm).expand_query_labels(scope, "our contracts")
    assert labels == ["lease", "sale"]


async def test_expansion_disabled_returns_nothing(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("legalco"), [("legal", 0)])
    # Ontology present but the flag never set ⇒ enabled=false ⇒ layer inert (CA#5, off=identical).
    await OntologyStore(harness.sm).add(
        harness.scope(project), name="onto", content=ONTOLOGY, fmt="turtle"
    )
    scope = harness.scope(project, allowed_topics=["legal"])
    assert await OntologyRecall(harness.sm).expand_query_labels(scope, "our contracts") == []


# --- FR-17.8 REGLA DURA: expansion never widens visibility (0 leaks) ---------


async def test_expansion_respects_permission_cut(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("legalco"), [("legal", 0), ("secret", 3)])
    await _enable_ontology(harness, project)
    # A "lease" document tagged with a SENSITIVE topic.
    await _publish(
        harness,
        project,
        b"# Confidential\n\nThe commercial lease agreement is sealed.\n",
        tags=["secret"],
    )
    async with harness.sm() as session:
        chunk_ids = {
            str(c)
            for c in await session.scalars(
                select(models.Chunk.id).where(
                    models.Chunk.project_id == uuid.UUID(project),
                    models.Chunk.embedding.is_not(None),
                )
            )
        }
    assert chunk_ids  # the lease chunk is embedded/recallable

    forbidden = await sensitive_tags(harness.sm, project)
    retriever = _retriever(harness, with_ontology=True)

    deny_scope: ProjectScope = harness.scope(project, allowed_topics=["legal"])  # lacks 'secret'
    allow_scope: ProjectScope = harness.scope(project, allowed_topics=["legal", "secret"])
    denied = await retriever._ontology_expand(deny_scope, "contracts", forbidden, [])
    allowed = await retriever._ontology_expand(allow_scope, "contracts", forbidden, [])

    # The query "contracts" expands to "lease", but the sensitive chunk only surfaces for the
    # caller that owns the tag — the ontology never bypasses the deterministic permission cut.
    assert not (chunk_ids & set(denied))
    assert chunk_ids & set(allowed)


async def test_ontology_expand_noop_without_collaborator(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("legalco"), [("legal", 0)])
    await _enable_ontology(harness, project)
    scope = harness.scope(project, allowed_topics=["legal"])
    retriever = _retriever(harness, with_ontology=False)  # ontology=None ⇒ identical to base
    seeds = ["11111111-1111-1111-1111-111111111111"]
    assert await retriever._ontology_expand(scope, "contracts", frozenset(), seeds) == seeds
