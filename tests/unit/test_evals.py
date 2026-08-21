"""Unit: the foundational-content validator passes on the shipped prompts/templates/taxonomy."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import yaml
from evals.schema import Corpus, EvidenceExpectation, ExpectedValidity, Golden, GoldenCase
from evals.validate import (
    REQUIRED_PROMPTS,
    REQUIRED_TEMPLATES,
    check_prompt_injection,
    check_prompts,
    check_taxonomy,
    check_templates,
    validate,
)

EVALS_DIR = Path(__file__).resolve().parents[2] / "evals"


def test_golden_evidence_preserves_absent_validity_vs_explicit_unknown_bounds() -> None:
    shared = {
        "id": "t1",
        "family": "temporal",
        "question": "What is the current SLA?",
        "user": "alice",
        "project": "acme",
        "must_find": True,
    }
    omitted = GoldenCase(**shared, expected_evidence=[{"must_include": ["12 hours"]}])
    unknown = GoldenCase(
        **shared,
        expected_evidence=[
            {
                "must_include": ["12 hours"],
                "validity": {"valid_from": None, "valid_to": None},
            }
        ],
    )

    assert omitted.expected_evidence[0].validity is None
    assert unknown.expected_evidence[0].validity == ExpectedValidity(valid_from=None, valid_to=None)


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


def test_temporal_golden_cases_bind_exact_corpus_evidence_and_exclusions() -> None:
    golden = Golden.model_validate(yaml.safe_load((EVALS_DIR / "golden.yaml").read_text()))
    cases = {case.id: case for case in golden.cases}

    assert cases["t1"].must_exclude == ["24 hours"]
    assert cases["t1"].expected_evidence == (
        EvidenceExpectation(
            must_include=("12 hours",),
            document_id="acme-sla-2024-en",
            validity=ExpectedValidity(valid_from=date(2024, 1, 1), valid_to=None),
            expected_is_current=True,
        ),
    )
    assert cases["t5"].must_find is False
    assert cases["t5"].must_exclude == ["24 hours"]
    assert cases["t6"].must_find is False
    assert cases["t6"].must_exclude == ["100 EUR per hour"]
    assert cases["t7"].must_exclude == ["12 hours"]
    assert cases["t7"].expected_evidence == (
        EvidenceExpectation(
            must_include=("24 hours",),
            document_id="acme-sla-2023-en",
            validity=ExpectedValidity(valid_from=date(2023, 1, 1), valid_to=date(2024, 1, 1)),
            expected_is_current=False,
        ),
    )
    assert cases["t9"].surface == "timeline"
    assert cases["t9"].must_exclude == ["100 EUR per hour"]
    assert cases["t9"].expected_evidence == (
        EvidenceExpectation(
            must_include=("24 hours",),
            document_id="acme-sla-2023-en",
            validity=ExpectedValidity(valid_from=date(2023, 1, 1), valid_to=date(2024, 1, 1)),
            expected_is_current=False,
        ),
        EvidenceExpectation(
            must_include=("12 hours",),
            document_id="acme-sla-2024-en",
            validity=ExpectedValidity(valid_from=date(2024, 1, 1), valid_to=None),
            expected_is_current=True,
        ),
    )


def test_temporal_corpus_states_each_half_open_boundary_in_the_source_body() -> None:
    corpus = Corpus.model_validate(yaml.safe_load((EVALS_DIR / "documents.yaml").read_text()))
    documents = {document.id: document for document in corpus.documents}

    expected = {
        "acme-sla-2023-en": ("2023-01-01", "2024-01-01", "exclusive"),
        "acme-sla-2024-en": ("2024-01-01", "onward"),
        "globex-rate-2022-en": ("2022-01-01", "2024-01-01", "exclusive"),
        "globex-rate-2024-en": ("2024-01-01", "onward"),
    }
    for document_id, required_text in expected.items():
        body = documents[document_id].body
        assert all(value in body for value in required_text), document_id
