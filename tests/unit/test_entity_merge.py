"""Alias-merge similarity + proposers (SPEC-09, pure / fake-gateway)."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.knowledge.entity_merge import (
    DeterministicMergeProposer,
    LlmMergeProposer,
    dice_coefficient,
    entity_similarity,
)
from rsc_brain.stores.relational.entity_store import EntityRow
from tests.conftest import completion_response


def _entity(eid: str, name: str, etype: str = "org", aliases: tuple[str, ...] = ()) -> EntityRow:
    return EntityRow(
        id=eid, name=name, normalized_name=name.casefold(), type=etype, aliases=aliases
    )


def test_dice_coefficient() -> None:
    assert dice_coefficient("acme", "acme") == 1.0
    assert dice_coefficient("acme corp", "acme corporation") > 0.6
    assert dice_coefficient("google", "microsoft") < 0.2
    assert dice_coefficient("a", "b") == 0.0  # too short, unequal


def test_entity_similarity_shared_surface_form_is_exact() -> None:
    a = _entity("1", "Acme Corporation")
    b = _entity("2", "Acme Inc", aliases=("Acme Corporation",))
    assert entity_similarity(a, b) == 1.0


def test_entity_similarity_distinct_entities_score_low() -> None:
    assert entity_similarity(_entity("1", "Google"), _entity("2", "Microsoft")) < 0.5


async def test_deterministic_proposer_proposes_near_duplicates() -> None:
    proposer = DeterministicMergeProposer(min_similarity=0.82)
    fuller = _entity("1", "Acme Corporation", aliases=("ACME", "Acme Co"))
    dup = _entity("2", "Acme Corporaton")  # typo, same type
    candidates = await proposer.propose([fuller, dup])
    assert len(candidates) == 1
    # The fuller record (more aliases) is chosen as canonical.
    assert candidates[0].canonical_id == "1"
    assert candidates[0].duplicate_id == "2"
    assert candidates[0].confidence >= 0.82


async def test_deterministic_proposer_ignores_cross_type() -> None:
    proposer = DeterministicMergeProposer(min_similarity=0.82)
    a = _entity("1", "Mercury", etype="planet")
    b = _entity("2", "Mercury", etype="element")
    assert await proposer.propose([a, b]) == []


async def test_deterministic_proposer_ignores_distinct_names() -> None:
    proposer = DeterministicMergeProposer(min_similarity=0.82)
    assert await proposer.propose([_entity("1", "Google"), _entity("2", "Microsoft")]) == []


def _pairs_completion(pairs: list[dict[str, Any]]) -> Callable[..., Any]:
    async def _fn(**kwargs: Any) -> Any:
        name = getattr(kwargs.get("response_format"), "__name__", "")
        if name == "_MergePairsOut":
            return completion_response(json.dumps({"pairs": pairs}))
        return completion_response("{}")

    return _fn


async def test_llm_proposer_parses_pairs_and_orients(
    gateway_factory: Callable[..., ModelGateway],
) -> None:
    gateway = gateway_factory(
        completion=_pairs_completion([{"a": "2", "b": "1", "confidence": 0.91}])
    )
    proposer = LlmMergeProposer(gateway, min_confidence=0.5)
    fuller = _entity("1", "Acme Corporation", aliases=("ACME",))
    dup = _entity("2", "Acme")
    candidates = await proposer.propose([fuller, dup])
    assert len(candidates) == 1
    assert candidates[0].canonical_id == "1"  # oriented regardless of the model's a/b order
    assert candidates[0].duplicate_id == "2"
    assert candidates[0].confidence == 0.91


async def test_llm_proposer_drops_below_min_confidence(
    gateway_factory: Callable[..., ModelGateway],
) -> None:
    gateway = gateway_factory(
        completion=_pairs_completion([{"a": "1", "b": "2", "confidence": 0.3}])
    )
    proposer = LlmMergeProposer(gateway, min_confidence=0.5)
    candidates = await proposer.propose([_entity("1", "Acme"), _entity("2", "Acme Inc")])
    assert candidates == []
