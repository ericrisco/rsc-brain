"""Prompt loading + structured schemas (SPEC-02 prompts, SPEC-05 schemas)."""

from __future__ import annotations

import pytest

from rsc_brain.ingest.prompts import (
    ClaimExtraction,
    EntityExtraction,
    RelationExtraction,
    TopicAssignment,
    load_prompt,
)


@pytest.mark.parametrize(
    "prompt_id",
    [
        "extractor_entities",
        "extractor_relations",
        "extractor_claims",
        "topicalizer",
        "contradiction_judge",
    ],
)
def test_prompt_loads_without_frontmatter(prompt_id: str) -> None:
    body = load_prompt(prompt_id)
    assert body
    assert not body.startswith("---")  # YAML frontmatter stripped
    # The AUDIT-008 untrusted-data precedence block is preserved in the body.
    assert "Untrusted input" in body or "untrusted" in body.lower()


def test_missing_prompt_raises() -> None:
    with pytest.raises(FileNotFoundError):
        load_prompt("does_not_exist")


def test_schemas_validate_expected_shapes() -> None:
    assert EntityExtraction.model_validate_json('{"entities": []}').entities == []
    rel = RelationExtraction.model_validate_json(
        '{"relations": [{"subject": "a", "predicate": "p", "object": "b"}]}'
    )
    assert rel.relations[0].predicate == "p"
    claims = ClaimExtraction.model_validate_json('{"claims": [{"text": "t"}]}')
    assert claims.claims[0].subject is None
    assert TopicAssignment.model_validate_json('{"tags": ["hr"]}').tags == ["hr"]
