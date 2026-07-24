"""Ontology storage against real Postgres (SPEC-24, FR-17.1): versioning, validation, coverage."""

from __future__ import annotations

from collections.abc import Callable

import pytest

from rsc_brain.ontology.index import OntologyParseError
from rsc_brain.ontology.store import OntologyStore
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("legal", 0)]
ONTO_V1 = """
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix ex: <http://example.org/legal#> .
ex:Contract a owl:Class ; rdfs:label "contract" .
ex:Lease a owl:Class ; rdfs:label "lease" ; rdfs:subClassOf ex:Contract .
"""
ONTO_V2 = ONTO_V1 + 'ex:Sale a owl:Class ; rdfs:label "sale" ; rdfs:subClassOf ex:Contract .\n'


async def test_add_and_list(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("legalco"), TOPICS)
    scope = harness.scope(project)
    store = OntologyStore(harness.sm)

    ontology_id = await store.add(scope, name="legal", content=ONTO_V1, fmt="turtle")
    assert ontology_id
    rows = await store.list_all(scope)
    assert len(rows) == 1
    assert rows[0].name == "legal"
    assert rows[0].active is True
    assert rows[0].version == 1
    assert rows[0].triples > 0


async def test_add_invalid_raises(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("legalco"), TOPICS)
    scope = harness.scope(project)
    with pytest.raises(OntologyParseError):
        await OntologyStore(harness.sm).add(
            scope, name="broken", content="@@@ not rdf ;;;", fmt="turtle"
        )
    assert await OntologyStore(harness.sm).list_all(scope) == []


async def test_new_version_deactivates_prior(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("legalco"), TOPICS)
    scope = harness.scope(project)
    store = OntologyStore(harness.sm)

    await store.add(scope, name="legal", content=ONTO_V1, fmt="turtle")
    await store.add(scope, name="legal", content=ONTO_V2, fmt="turtle")

    rows = {(r.version, r.active) for r in await store.list_all(scope)}
    assert rows == {(1, False), (2, True)}  # last active, prior still queryable


async def test_active_index_merges_and_reflects_version(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("legalco"), TOPICS)
    scope = harness.scope(project)
    store = OntologyStore(harness.sm)

    await store.add(scope, name="legal", content=ONTO_V1, fmt="turtle")
    index_v1 = await store.active_index(scope)
    assert index_v1 is not None
    assert index_v1.anchor("sale") is None  # not in v1

    await store.add(scope, name="legal", content=ONTO_V2, fmt="turtle")
    index_v2 = await store.active_index(scope)
    assert index_v2 is not None
    assert index_v2.anchor("sale") is not None  # v2 is now the active one


async def test_coverage_matches_counts(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("legalco"), TOPICS)
    scope = harness.scope(project)
    coverage = await OntologyStore(harness.sm).coverage(scope)
    # A fresh project has no entities ⇒ 0/0, coverage 0.0, no unanchored names.
    assert coverage == {"total": 0, "anchored": 0, "coverage": 0.0, "top_unanchored": []}
