"""Temporal evals must validate evidence, not merely a retrieval hit."""

from __future__ import annotations

from dataclasses import replace
from datetime import date

import pytest
from evals.runner import EvalCase, observe, run_eval
from evals.schema import EvidenceExpectation, ExpectedValidity

from rsc_brain.recall.interfaces import Fragment, RecallResult
from rsc_brain.recall.timeline import TimelineEntry


def _fragment(
    text: str,
    *,
    valid_from: date | None = None,
    valid_to: date | None = None,
    is_current: bool = True,
) -> Fragment:
    return Fragment(
        text=text,
        document_id="doc-1",
        score=0.9,
        valid_from=valid_from,
        valid_to=valid_to,
        is_current=is_current,
    )


def _temporal_case() -> EvalCase:
    return EvalCase(
        case_id="t1",
        family="temporal",
        question="What is the current Acme support SLA?",
        user="alice",
        project="acme",
        must_find=True,
        must_exclude=("24 hours",),
        expected_evidence=(
            EvidenceExpectation(
                must_include=("12 hours",),
                document_id="doc-1",
                validity=ExpectedValidity(valid_from=date(2024, 1, 1), valid_to=None),
                expected_is_current=True,
            ),
        ),
    )


@pytest.mark.asyncio
async def test_wrong_fragment_with_found_true_fails_structured_temporal_case() -> None:
    async def recall(_: EvalCase) -> RecallResult:
        return RecallResult(found=True, fragments=(_fragment("The support SLA is 24 hours."),))

    report = await run_eval([_temporal_case()], recall)

    assert report.retrieval_precision == 0.0


@pytest.mark.asyncio
async def test_expected_text_with_wrong_interval_or_currentness_fails() -> None:
    async def recall(_: EvalCase) -> RecallResult:
        return RecallResult(
            found=True,
            fragments=(
                _fragment(
                    "The support SLA is 12 hours.",
                    valid_from=date(2023, 1, 1),
                    valid_to=date(2024, 1, 1),
                    is_current=False,
                ),
            ),
        )

    report = await run_eval([_temporal_case()], recall)

    assert report.retrieval_precision == 0.0


@pytest.mark.asyncio
async def test_expected_case_fails_when_an_excluded_stale_fact_is_present() -> None:
    async def recall(_: EvalCase) -> RecallResult:
        return RecallResult(
            found=True,
            fragments=(
                _fragment("The support SLA is 12 hours.", valid_from=date(2024, 1, 1)),
                _fragment("The former support SLA was 24 hours.", valid_from=date(2023, 1, 1)),
            ),
        )

    report = await run_eval([_temporal_case()], recall)

    assert report.retrieval_precision == 0.0


@pytest.mark.asyncio
async def test_security_abstention_still_uses_indistinguishable_safe_failure() -> None:
    async def recall(_: EvalCase) -> RecallResult:
        return RecallResult(found=False)

    case = EvalCase(
        case_id="d1",
        family="denied",
        question="What are the salary bands?",
        user="bob",
        project="acme",
        must_find=False,
    )
    report = await run_eval([case], recall)

    assert report.correct_abstention_rate == 1.0
    assert report.permission_leaks == 0


def test_security_leak_failure_never_contains_returned_evidence() -> None:
    case = EvalCase(
        case_id="d1",
        family="denied",
        question="What are the salary bands?",
        user="bob",
        project="acme",
        must_find=False,
    )
    outcome = observe(
        case,
        RecallResult(found=False, fragments=(_fragment("protected salary amount"),)),
    )

    assert outcome.passed is False
    assert outcome.failures == ("security_abstention_failed",)
    assert "protected" not in " ".join(outcome.failures)


def test_expected_recall_surface_rejects_a_timeline_result() -> None:
    case = EvalCase(
        case_id="h1",
        family="hit",
        question="What is the SLA?",
        user="alice",
        project="acme",
        must_find=True,
        surface="recall",
    )
    timeline = (
        TimelineEntry(
            claim_id="claim-2024",
            text="The support SLA is 12 hours.",
            subject="Acme",
            predicate="support_sla",
            object="12 hours",
            credibility=1.0,
            tags=("general",),
            valid_from=date(2024, 1, 1),
            valid_to=None,
            is_current=True,
            document_id="doc-2024",
        ),
    )

    outcome = observe(case, timeline)

    assert outcome.passed is False
    assert outcome.failures == ("wrong_evaluation_surface",)


@pytest.mark.asyncio
async def test_t9_explicit_timeline_surface_never_calls_normal_recall() -> None:
    recalled = False

    async def recall(_: EvalCase) -> RecallResult:
        nonlocal recalled
        recalled = True
        return RecallResult(found=True, fragments=(_fragment("wrong recall result"),))

    async def timeline(_: EvalCase) -> tuple[TimelineEntry, ...]:
        return (
            TimelineEntry(
                claim_id="2023",
                text="The support SLA was 24 hours in 2023.",
                subject="Acme",
                predicate="support_sla",
                object="24 hours",
                credibility=1.0,
                tags=("general",),
                valid_from=date(2023, 1, 1),
                valid_to=date(2024, 1, 1),
                is_current=False,
                document_id="doc-2023",
            ),
            TimelineEntry(
                claim_id="2024",
                text="The support SLA is 12 hours in 2024.",
                subject="Acme",
                predicate="support_sla",
                object="12 hours",
                credibility=1.0,
                tags=("general",),
                valid_from=date(2024, 1, 1),
                valid_to=None,
                is_current=True,
                document_id="doc-2024",
            ),
        )

    case = replace(
        _temporal_case(),
        case_id="t9",
        question="How has the Acme support SLA evolved over time?",
        surface="timeline",
        must_exclude=(),
        expected_evidence=(
            EvidenceExpectation(
                must_include=("24 hours",),
                document_id="doc-2023",
                validity=ExpectedValidity(valid_from=date(2023, 1, 1), valid_to=date(2024, 1, 1)),
                expected_is_current=False,
            ),
            EvidenceExpectation(
                must_include=("12 hours",),
                document_id="doc-2024",
                validity=ExpectedValidity(valid_from=date(2024, 1, 1), valid_to=None),
                expected_is_current=True,
            ),
        ),
    )
    report = await run_eval([case], recall, timeline)

    assert recalled is False
    assert report.retrieval_precision == 1.0


@pytest.mark.asyncio
async def test_expected_explicit_null_validity_rejects_a_dated_fragment() -> None:
    """An omitted validity assertion differs from explicitly expected unknown boundaries."""

    async def recall(_: EvalCase) -> RecallResult:
        return RecallResult(
            found=True,
            fragments=(
                _fragment(
                    "The support SLA is 12 hours.",
                    valid_from=date(2024, 1, 1),
                    is_current=True,
                ),
            ),
        )

    report = await run_eval(
        [
            replace(
                _temporal_case(),
                must_exclude=(),
                expected_evidence=(
                    EvidenceExpectation(
                        must_include=("12 hours",),
                        validity=ExpectedValidity(valid_from=None, valid_to=None),
                        expected_is_current=True,
                    ),
                ),
            )
        ],
        recall,
    )

    assert report.retrieval_precision == 0.0


@pytest.mark.asyncio
async def test_expected_evidence_cannot_borrow_fact_and_validity_from_two_fragments() -> None:
    async def recall(_: EvalCase) -> RecallResult:
        return RecallResult(
            found=True,
            fragments=(
                _fragment("The support SLA is 12 hours.", valid_from=date(2023, 1, 1)),
                _fragment("The 2024 policy is current.", valid_from=date(2024, 1, 1)),
            ),
        )

    report = await run_eval(
        [
            replace(
                _temporal_case(),
                must_exclude=(),
                expected_evidence=(
                    EvidenceExpectation(
                        must_include=("12 hours", "2024"),
                        validity=ExpectedValidity(valid_from=date(2024, 1, 1), valid_to=None),
                        expected_is_current=True,
                    ),
                ),
            )
        ],
        recall,
    )

    assert report.retrieval_precision == 0.0


@pytest.mark.asyncio
async def test_expected_evidence_does_not_reuse_a_fragment() -> None:
    async def recall(_: EvalCase) -> RecallResult:
        return RecallResult(
            found=True,
            fragments=(_fragment("The support SLA is 12 hours.", valid_from=date(2024, 1, 1)),),
        )

    case = replace(
        _temporal_case(),
        must_exclude=(),
        expected_evidence=(
            EvidenceExpectation(must_include=("12 hours",), document_id="doc-1"),
            EvidenceExpectation(must_include=("12 hours",), document_id="doc-1"),
        ),
    )
    report = await run_eval([case], recall)

    assert report.retrieval_precision == 0.0


@pytest.mark.asyncio
async def test_expected_evidence_binds_document_provenance() -> None:
    async def recall(_: EvalCase) -> RecallResult:
        return RecallResult(
            found=True,
            fragments=(_fragment("The support SLA is 12 hours.", valid_from=date(2024, 1, 1)),),
        )

    case = replace(
        _temporal_case(),
        must_exclude=(),
        expected_evidence=(
            EvidenceExpectation(must_include=("12 hours",), document_id="another-document"),
        ),
    )
    report = await run_eval([case], recall)

    assert report.retrieval_precision == 0.0


@pytest.mark.asyncio
async def test_expected_abstention_rejects_hidden_fragments_behind_false_wrapper() -> None:
    async def recall(_: EvalCase) -> RecallResult:
        return RecallResult(found=False, fragments=(_fragment("The stale SLA was 24 hours."),))

    case = EvalCase(
        case_id="t5",
        family="temporal",
        question="Is the old SLA current?",
        user="alice",
        project="acme",
        must_find=False,
        must_exclude=("24 hours",),
    )
    report = await run_eval([case], recall)

    assert report.correct_abstention_rate == 0.0


@pytest.mark.asyncio
async def test_timeline_expected_evidence_rejects_reversed_eras() -> None:
    async def recall(_: EvalCase) -> RecallResult:
        raise AssertionError("t9 must not call recall")

    async def timeline(_: EvalCase) -> tuple[TimelineEntry, ...]:
        return (
            TimelineEntry(
                claim_id="2024",
                text="The support SLA is 12 hours in 2024.",
                subject="Acme",
                predicate="support_sla",
                object="12 hours",
                credibility=1.0,
                tags=("general",),
                valid_from=date(2024, 1, 1),
                valid_to=None,
                is_current=True,
                document_id="doc-2024",
            ),
            TimelineEntry(
                claim_id="2023",
                text="The support SLA was 24 hours in 2023.",
                subject="Acme",
                predicate="support_sla",
                object="24 hours",
                credibility=1.0,
                tags=("general",),
                valid_from=date(2023, 1, 1),
                valid_to=date(2024, 1, 1),
                is_current=False,
                document_id="doc-2023",
            ),
        )

    case = replace(
        _temporal_case(),
        case_id="t9",
        surface="timeline",
        must_exclude=(),
        expected_evidence=(
            EvidenceExpectation(
                must_include=("24 hours",),
                document_id="doc-2023",
                validity=ExpectedValidity(valid_from=date(2023, 1, 1), valid_to=date(2024, 1, 1)),
                expected_is_current=False,
            ),
            EvidenceExpectation(
                must_include=("12 hours",),
                document_id="doc-2024",
                validity=ExpectedValidity(valid_from=date(2024, 1, 1), valid_to=None),
                expected_is_current=True,
            ),
        ),
    )
    report = await run_eval([case], recall, timeline)

    assert report.retrieval_precision == 0.0
