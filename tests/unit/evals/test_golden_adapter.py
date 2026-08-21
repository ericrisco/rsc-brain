"""Golden YAML cases become runnable without dropping their temporal oracle."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import yaml
from evals.runner import eval_case_from_golden
from evals.schema import ExpectedValidity, Golden, GoldenCase

EVALS_DIR = Path(__file__).resolve().parents[3] / "evals"


def _temporal_case(case_id: str) -> GoldenCase:
    golden = Golden.model_validate(yaml.safe_load((EVALS_DIR / "golden.yaml").read_text()))
    return next(case for case in golden.cases if case.id == case_id)


def test_golden_adapter_preserves_timeline_oracle_and_resolves_document_provenance() -> None:
    case = eval_case_from_golden(
        _temporal_case("t9"),
        document_ids={
            "acme-sla-2023-en": "runtime-doc-2023",
            "acme-sla-2024-en": "runtime-doc-2024",
        },
    )

    assert case.question == "How has the Acme support SLA evolved over time?"
    assert case.user == "alice"
    assert case.project == "acme"
    assert case.surface == "timeline"
    assert case.must_exclude == ("100 EUR per hour",)
    assert [item.document_id for item in case.expected_evidence] == [
        "runtime-doc-2023",
        "runtime-doc-2024",
    ]
    assert [item.validity for item in case.expected_evidence] == [
        ExpectedValidity(valid_from=date(2023, 1, 1), valid_to=date(2024, 1, 1)),
        ExpectedValidity(valid_from=date(2024, 1, 1), valid_to=None),
    ]
    assert [item.expected_is_current for item in case.expected_evidence] == [False, True]


def test_golden_adapter_keeps_strict_temporal_abstention() -> None:
    case = eval_case_from_golden(_temporal_case("t5"))

    assert case.question == "Is the 24-hour SLA still current at Acme?"
    assert case.must_find is False
    assert case.must_exclude == ("24 hours",)
    assert case.expected_evidence == ()
