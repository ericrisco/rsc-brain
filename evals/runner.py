"""Golden-set eval runner (PRD §12): run each case through recall, time it, aggregate metrics.

The runner is transport-agnostic — it takes a ``recall_fn`` that maps a case to a
:class:`~rsc_brain.recall.interfaces.RecallResult` (the caller wires the per-case user scope). A
full run over ``golden.yaml`` against a live model is blocked-by-resource; the runner + metrics are
exercised in CI with the deterministic gateway.
"""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Literal

from evals.metrics import CaseOutcome, EvalReport, calibrate_tau, compute_eval_metrics
from evals.schema import EvidenceExpectation, ExpectedValidity, GoldenCase
from rsc_brain.recall.interfaces import Fragment, RecallResult
from rsc_brain.recall.timeline import TimelineEntry


@dataclass(frozen=True, slots=True)
class EvalCase:
    case_id: str
    family: str
    must_find: bool
    question: str = ""
    user: str = ""
    project: str = ""
    must_include: tuple[str, ...] = ()
    must_exclude: tuple[str, ...] = ()
    expected_valid_from: date | None = None
    expected_valid_to: date | None = None
    expected_is_current: bool | None = None
    surface: Literal["recall", "timeline"] = "recall"
    expected_evidence: tuple[EvidenceExpectation, ...] = ()


RecallFn = Callable[[EvalCase], Awaitable[RecallResult]]
TimelineResult = Sequence[TimelineEntry]
TimelineFn = Callable[[EvalCase], Awaitable[TimelineResult]]


def eval_case_from_golden(
    case: GoldenCase, *, document_ids: Mapping[str, str] | None = None
) -> EvalCase:
    """Build one runnable case; resolve corpus ids only after real ingestion assigns UUIDs."""
    resolved_ids = document_ids or {}
    evidence = tuple(
        expectation.model_copy(
            update={
                "document_id": resolved_ids.get(expectation.document_id, expectation.document_id)
            }
        )
        if expectation.document_id is not None
        else expectation
        for expectation in case.expected_evidence
    )
    return EvalCase(
        case_id=case.id,
        family=case.family,
        must_find=case.must_find,
        question=case.question,
        user=case.user,
        project=case.project,
        must_include=tuple(case.must_include),
        must_exclude=tuple(case.must_exclude),
        expected_valid_from=case.expected_valid_from,
        expected_valid_to=case.expected_valid_to,
        expected_is_current=case.expected_is_current,
        surface=case.surface,
        expected_evidence=evidence,
    )


async def run_eval(
    cases: Sequence[EvalCase], recall_fn: RecallFn, timeline_fn: TimelineFn | None = None
) -> EvalReport:
    """Run every case through ``recall_fn``, measuring latency, and aggregate the §12 report."""
    outcomes: list[CaseOutcome] = []
    for case in cases:
        start = time.monotonic()
        if case.surface == "timeline":
            if timeline_fn is None:
                raise ValueError("timeline cases require a timeline_fn")
            result: RecallResult | TimelineResult = await timeline_fn(case)
        else:
            result = await recall_fn(case)
        latency_ms = (time.monotonic() - start) * 1000.0
        outcomes.append(observe(case, result, latency_ms=latency_ms))
    return compute_eval_metrics(outcomes)


def observe(
    case: EvalCase,
    result: RecallResult | TimelineResult,
    *,
    latency_ms: float = 0.0,
    forbidden_topics: frozenset[str] | None = None,
) -> CaseOutcome:
    """Evaluate recall or timeline evidence against a golden case without disclosing hidden facts.

    A case with no structured expectations intentionally keeps the original found/not-found verdict.
    Security abstentions are stricter: an unexpected fragment is a FAILURE even when a broken
    transport labels the enclosing result ``found=False``.

    ``forbidden_topics`` is what the principal may not see. Supplied, it decides ``disclosed`` — the
    only thing `permission_leaks` counts (AUDIT-127). Omitted, ``disclosed`` stays ``None`` and no
    leak is claimed in either direction.
    """
    entries: Sequence[Fragment | TimelineEntry]
    if isinstance(result, RecallResult):
        found = result.found
        entries = result.fragments
        max_score = result.fragments[0].score if result.fragments else 0.0
    else:
        found = bool(result)
        entries = result
        max_score = max((entry.credibility for entry in result), default=0.0)

    result_is_recall = isinstance(result, RecallResult)
    if (case.surface == "recall") != result_is_recall:
        return _outcome(
            case,
            found=found,
            max_score=max_score,
            latency_ms=latency_ms,
            failures=("wrong_evaluation_surface",),
            disclosed=_disclosed(entries, forbidden_topics),
        )

    if case.family in {"denied", "cross_project"} and not case.must_find:
        passed = not found and not entries
        return _outcome(
            case,
            found=found,
            max_score=max_score,
            latency_ms=latency_ms,
            failures=() if passed else ("security_abstention_failed",),
            disclosed=_disclosed(entries, forbidden_topics),
        )

    if not case.must_find:
        abstention_failures: list[str] = []
        if found or entries:
            abstention_failures.append("unexpected_evidence")
        if _contains_excluded_evidence(case, entries):
            abstention_failures.append("excluded_evidence_returned")
        return _outcome(
            case,
            found=found,
            max_score=max_score,
            latency_ms=latency_ms,
            failures=tuple(abstention_failures),
            disclosed=_disclosed(entries, forbidden_topics),
        )

    failures: list[str] = []
    if not found:
        failures.append("not_found")
    if _contains_excluded_evidence(case, entries):
        failures.append("excluded_evidence_returned")
    expectations = _expected_evidence(case)
    if expectations and not _expectations_match(case.surface, expectations, entries):
        failures.append("missing_expected_evidence")
    return _outcome(
        case,
        found=found,
        disclosed=_disclosed(entries, forbidden_topics),
        max_score=max_score,
        latency_ms=latency_ms,
        failures=tuple(failures),
    )


def _topics_of(entry: Fragment | TimelineEntry) -> frozenset[str]:
    """A fragment's topics. Production carries them in `provenance` (`retriever._assemble`); a
    timeline entry carries them as an attribute."""
    provenance = getattr(entry, "provenance", None)
    if isinstance(provenance, Mapping):
        tags = provenance.get("tags")
        if isinstance(tags, (list, tuple, set, frozenset)):
            return frozenset(str(tag) for tag in tags)
    tags = getattr(entry, "tags", None)
    if isinstance(tags, (list, tuple, set, frozenset)):
        return frozenset(str(tag) for tag in tags)
    return frozenset()


def _disclosed(
    entries: Sequence[Fragment | TimelineEntry], forbidden_topics: frozenset[str] | None
) -> bool | None:
    """Whether anything carrying a forbidden topic was returned. ``None`` when nobody said what was
    forbidden — the one honest answer when the input is absent (AUDIT-127)."""
    if forbidden_topics is None:
        return None
    return any(_topics_of(entry) & forbidden_topics for entry in entries)


def _outcome(
    case: EvalCase,
    *,
    found: bool,
    max_score: float,
    latency_ms: float,
    failures: tuple[str, ...],
    disclosed: bool | None = None,
) -> CaseOutcome:
    return CaseOutcome(
        case_id=case.case_id,
        family=case.family,
        must_find=case.must_find,
        found=found,
        max_score=max_score,
        latency_ms=latency_ms,
        passed=not failures,
        failures=failures,
        disclosed=disclosed,
    )


def _expected_evidence(case: EvalCase) -> tuple[EvidenceExpectation, ...]:
    """Prefer atomic expectations while retaining the former case-level contract for legacy sets."""
    if case.expected_evidence:
        return case.expected_evidence
    validity = (
        ExpectedValidity(
            valid_from=case.expected_valid_from,
            valid_to=case.expected_valid_to,
        )
        if case.expected_valid_from is not None or case.expected_valid_to is not None
        else None
    )
    if case.must_include or validity is not None or case.expected_is_current is not None:
        return (
            EvidenceExpectation(
                must_include=case.must_include,
                validity=validity,
                expected_is_current=case.expected_is_current,
            ),
        )
    return ()


def _contains_excluded_evidence(
    case: EvalCase, entries: Sequence[Fragment | TimelineEntry]
) -> bool:
    return any(
        excluded.casefold() in _evidence_text(entry).casefold()
        for excluded in case.must_exclude
        for entry in entries
    )


def _expectations_match(
    surface: Literal["recall", "timeline"],
    expectations: Sequence[EvidenceExpectation],
    entries: Sequence[Fragment | TimelineEntry],
) -> bool:
    """Bind every expectation to one entry, preserving timeline evolution order."""
    if surface == "timeline":
        next_entry = 0
        for expectation in expectations:
            match = next(
                (
                    index
                    for index in range(next_entry, len(entries))
                    if _entry_matches(expectation, entries[index])
                ),
                None,
            )
            if match is None:
                return False
            next_entry = match + 1
        return True
    return _recall_expectations_match(expectations, entries, expectation_index=0, used=frozenset())


def _recall_expectations_match(
    expectations: Sequence[EvidenceExpectation],
    entries: Sequence[Fragment | TimelineEntry],
    *,
    expectation_index: int,
    used: frozenset[int],
) -> bool:
    if expectation_index == len(expectations):
        return True
    expectation = expectations[expectation_index]
    for index, entry in enumerate(entries):
        if (
            index not in used
            and _entry_matches(expectation, entry)
            and _recall_expectations_match(
                expectations,
                entries,
                expectation_index=expectation_index + 1,
                used=used | {index},
            )
        ):
            return True
    return False


def _entry_matches(expectation: EvidenceExpectation, entry: Fragment | TimelineEntry) -> bool:
    evidence = _evidence_text(entry).casefold()
    if any(required.casefold() not in evidence for required in expectation.must_include):
        return False
    if expectation.document_id is not None and _document_id(entry) != expectation.document_id:
        return False
    if expectation.validity is not None and (
        entry.valid_from != expectation.validity.valid_from
        or entry.valid_to != expectation.validity.valid_to
    ):
        return False
    return expectation.expected_is_current is None or (
        entry.is_current is expectation.expected_is_current
    )


def _document_id(entry: Fragment | TimelineEntry) -> str | None:
    return entry.document_id


def _evidence_text(entry: Fragment | TimelineEntry) -> str:
    """Make text plus provenance searchable without returning it in failure diagnostics."""
    if isinstance(entry, Fragment):
        return " ".join((entry.text, *(str(value) for value in entry.provenance.values())))
    return " ".join(
        value
        for value in (entry.text, entry.subject, entry.predicate, entry.object, entry.document_id)
        if value
    )


async def run_calibration(cases: Sequence[EvalCase], recall_fn: RecallFn) -> float:
    """Recall every case (the caller passes a τ=0 retriever so all return a top score) and return
    the τ that maximizes abstention F1 (D2)."""
    samples: list[tuple[bool, float]] = []
    for case in cases:
        result = await recall_fn(case)
        max_score = result.fragments[0].score if result.fragments else 0.0
        samples.append((case.must_find, max_score))
    return calibrate_tau(samples)
