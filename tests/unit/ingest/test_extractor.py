"""Cascade extractor (FR-1.8): success path + discard-and-log on structured-output failure."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest

from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.ingest.extractor import CascadeExtractor, ExtractionDiscarded


async def test_cascade_returns_entities_relations_claims(
    gateway_factory: Callable[..., ModelGateway],
    make_completion: Callable[..., Any],
) -> None:
    completion = make_completion(
        entities=[{"name": "Acme", "type": "org", "aliases": ["ACME"]}],
        relations=[{"subject": "Acme", "predicate": "uses", "object": "Acme"}],
        claims=[
            {"text": "Acme SLA is 24h", "subject": "Acme", "predicate": "sla", "object": "24h"}
        ],
    )
    graph = await CascadeExtractor(gateway_factory(completion=completion)).extract("some prose")
    assert [e.name for e in graph.entities] == ["Acme"]
    assert graph.entities[0].aliases == ("ACME",)
    assert graph.relations[0].predicate == "uses"
    assert graph.claims[0].object == "24h"


async def test_invalid_structured_output_is_discarded_with_stage(
    gateway_factory: Callable[..., ModelGateway],
    make_completion: Callable[..., Any],
) -> None:
    # Non-JSON for the entities schema even after repair → the whole chunk is discarded.
    completion = make_completion(invalid_for="poisoned chunk")
    with pytest.raises(ExtractionDiscarded) as excinfo:
        await CascadeExtractor(gateway_factory(completion=completion)).extract("poisoned chunk")
    assert excinfo.value.stage == "entities"
