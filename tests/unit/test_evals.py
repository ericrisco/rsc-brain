"""Unit: the foundational-content validator passes on the shipped prompts/templates/taxonomy."""

from __future__ import annotations

from evals.validate import (
    REQUIRED_PROMPTS,
    REQUIRED_TEMPLATES,
    check_prompt_injection,
    check_prompts,
    check_taxonomy,
    check_templates,
    validate,
)


def test_five_prompts_present_with_audit008_and_bilingual_fewshot() -> None:
    assert len(REQUIRED_PROMPTS) == 5
    assert check_prompts() == []


def test_eight_hunting_templates_at_canonical_path() -> None:
    assert len(REQUIRED_TEMPLATES) == 8
    assert check_templates() == []


def test_taxonomy_has_sensitive_topics_and_disjoint_slugs() -> None:
    assert check_taxonomy() == []


def test_prompt_injection_suite_has_every_required_surface_and_delivery() -> None:
    assert check_prompt_injection() == []


def test_validator_reports_no_errors() -> None:
    assert validate() == []
