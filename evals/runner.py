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
from rsc_brain.recall.reranker import Reranker
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


@dataclass(frozen=True, slots=True)
class TopicAuthority:
    """What a principal may see, and what the CORPUS says each document is (AUDIT-139).

    `declared` is the only ground truth an evaluation holds that the authorization filter does not
    also hold. Judging a disclosure by the fragment's *effective* tags asks the filter its own
    question: the wrong tag is what admitted the fragment, so the check then finds nothing wrong with
    it. Judging by what the corpus DECLARED catches a document that carries a topic it should not.

    Keys may be either the corpus document id or the runtime UUID; the lookup tries both, because the
    two surfaces carry different ones and a key mismatch here would silently make every case
    unjudgeable — reported as safety.
    """

    allowed: frozenset[str]
    declared: Mapping[str, frozenset[str]]
    #: The project's topics at or above the sensitivity threshold. Needed because visibility is not
    #: "holds any topic": a sensitive topic the caller does not hold VETOES, so a document declared
    #: `[hr, general]` must not reach a `general`-only caller even though the overlap allows it
    #: (FR-4.14, and the example in `rsc_brain/recall/permissions.py`'s own docstring).
    sensitive: frozenset[str] = frozenset()


def observe(
    case: EvalCase,
    result: RecallResult | TimelineResult,
    *,
    latency_ms: float = 0.0,
    forbidden_topics: frozenset[str] | None = None,
    authority: TopicAuthority | None = None,
) -> CaseOutcome:
    """Evaluate recall or timeline evidence against a golden case without disclosing hidden facts.

    A case with no structured expectations intentionally keeps the original found/not-found verdict.
    Security abstentions are stricter: an unexpected fragment is a FAILURE even when a broken
    transport labels the enclosing result ``found=False``.

    ``authority`` decides ``disclosed`` — the only thing `permission_leaks` counts (AUDIT-127) — by
    comparing each returned fragment's **declared** topics against the grant (AUDIT-139). It also
    decides ``filter_breach``, which is the older and stricter question: did the in-query filter itself
    return a topic this principal does not hold, at any sensitivity.

    ``forbidden_topics`` is the pre-AUDIT-139 input and still answers a real question — effective tags
    against a named forbidden set. It is used for ``disclosed`` only when no ``authority`` is given.
    With neither, ``disclosed`` stays ``None`` and no leak is claimed in either direction: absence of
    the input is not evidence of safety.
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

    disclosed = _disclosed(entries, forbidden_topics, authority)
    breach = _filter_breach(entries, authority)

    result_is_recall = isinstance(result, RecallResult)
    if (case.surface == "recall") != result_is_recall:
        return _outcome(
            case,
            found=found,
            max_score=max_score,
            latency_ms=latency_ms,
            failures=("wrong_evaluation_surface",),
            disclosed=disclosed,
            filter_breach=breach,
        )

    if case.family in {"denied", "cross_project"} and not case.must_find:
        passed = not found and not entries
        return _outcome(
            case,
            found=found,
            max_score=max_score,
            latency_ms=latency_ms,
            failures=() if passed else ("security_abstention_failed",),
            disclosed=disclosed,
            filter_breach=breach,
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
            disclosed=disclosed,
            filter_breach=breach,
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
        disclosed=disclosed,
        filter_breach=breach,
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


def _document_key(entry: Fragment | TimelineEntry) -> str | None:
    """The corpus id if the entry carries one, else the runtime id. Either can key `declared`."""
    provenance = getattr(entry, "provenance", None)
    if isinstance(provenance, Mapping):
        document = provenance.get("document")
        if isinstance(document, str) and document:
            return document
    for attribute in ("document", "document_id"):
        value = getattr(entry, attribute, None)
        if value:
            return str(value)
    return None


def visible_under(topics: frozenset[str], authority: TopicAuthority) -> bool:
    """The product's own visibility rule, applied to an arbitrary topic set.

    Mirrors `rsc_brain.recall.permissions.chunk_visibility_clause`, which is SQL and cannot be reused
    here:

        visible  <=>  topics & allowed  is non-empty
                 AND  topics & (project_sensitive - allowed)  is empty

    Both halves matter and they fail differently. Holding none of a document's topics means no basis
    to read it at all. Holding one of them is not enough when another is sensitive and unheld — that
    is FR-4.14, and the leak it prevents (`{hr, general}` reaching a `general`-only caller) is the
    example in the permission module's own docstring.

    A mirror can drift from what it mirrors. It is here rather than in the product because an
    evaluation needs to ask the question of tags the product never saw — the ones the corpus DECLARED
    — and a test pins it against the docstring's example.
    """
    if not topics:
        return False
    if not topics & authority.allowed:
        return False
    return not (topics & (authority.sensitive - authority.allowed))


def _judgeable(
    entries: Sequence[Fragment | TimelineEntry], authority: TopicAuthority
) -> list[frozenset[str]]:
    """The declared topic sets of the entries the corpus can speak for."""
    return [
        authority.declared[key]
        for entry in entries
        if (key := _document_key(entry)) is not None and authority.declared.get(key)
    ]


def _disclosed(
    entries: Sequence[Fragment | TimelineEntry],
    forbidden_topics: frozenset[str] | None,
    authority: TopicAuthority | None = None,
) -> bool | None:
    """Whether anything this principal may not see was returned.

    AUDIT-139: judged by re-applying the product's visibility rule to what the CORPUS declares each
    document to be. The old check used the effective tags — the same data the filter had just
    consulted — so a document carrying a topic it should not carry was admitted BY that topic and the
    check then found nothing forbidden about it. Measured on the shipped corpus, that hid two real
    disclosures behind a reported zero.

    ``None`` when nobody said what the principal may see, and also when entries were returned and NONE
    of them could be resolved to a declared tag set — a verdict on an empty sample would be a claim of
    safety derived from a missing input, which is the shape of AUDIT-090 and AUDIT-127.
    """
    if authority is not None:
        judged = _judgeable(entries, authority)
        if entries and not judged:
            return None
        return any(not visible_under(topics, authority) for topics in judged)
    if forbidden_topics is None:
        return None
    return any(_topics_of(entry) & forbidden_topics for entry in entries)


def _filter_breach(
    entries: Sequence[Fragment | TimelineEntry], authority: TopicAuthority | None
) -> bool | None:
    """Whether the in-query filter itself returned something it had no basis for (AUDIT-139 AC3).

    The same rule, applied to the tags the fragment actually carries. A different and harder failure
    than a disclosure: a disclosure needs only a mis-tagged document and a perfectly correct filter,
    whereas this says the SQL predicate let through a chunk that predicate should have excluded.

    Entries carrying no tags at all are skipped rather than counted. An adapter that forgot to pass
    provenance through would otherwise report a security breach on every case, which is a false alarm
    of exactly the kind AUDIT-127 removed.
    """
    if authority is None:
        return None
    carried = [topics for entry in entries if (topics := _topics_of(entry))]
    if entries and not carried:
        return None
    return any(not visible_under(topics, authority) for topics in carried)


def _outcome(
    case: EvalCase,
    *,
    found: bool,
    max_score: float,
    latency_ms: float,
    failures: tuple[str, ...],
    disclosed: bool | None = None,
    filter_breach: bool | None = None,
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
        filter_breach=filter_breach,
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


async def calibrate_reranker_tau(
    cases: Sequence[EvalCase],
    reranker: Reranker,
    candidates: Callable[[EvalCase], Awaitable[Sequence[str]]],
) -> float:
    """The τ that best separates answerable from unanswerable **on the reranker's own scale**.

    AUDIT-132. `run_calibration` below sweeps the BLENDED similarity — the quantity measured unable to
    meet G4, its populations overlapping by -0.032. Since AUDIT-085 abstention is decided by
    `recall.tau_rerank` over the reranker's relevance score, and nothing could suggest a value for it.

    AUDIT-131 made that a live trap: a cross-encoder puts an answer at 0.34 where a chat model puts it
    at 0.95, so carrying a threshold between routes abstains from everything. "Set it explicitly for
    your model" is correct advice and a poor tool; this is the tool.

    A case contributes the best score its candidates achieved. An **unscored** candidate contributes
    nothing rather than a zero: AUDIT-100's rule, and here a swept zero would drag the suggestion down
    for every install.
    """
    samples: list[tuple[bool, float]] = []
    for case in cases:
        passages = list(await candidates(case))
        if not passages:
            continue
        scores = await reranker.relevance(case.question, passages)
        judged = [score for score in scores if score is not None]
        if not judged:
            continue
        samples.append((case.must_find, max(judged)))
    return calibrate_tau(samples)


async def run_calibration(cases: Sequence[EvalCase], recall_fn: RecallFn) -> float:
    """Recall every case (the caller passes a τ=0 retriever so all return a top score) and return
    the τ that maximizes abstention F1 (D2)."""
    samples: list[tuple[bool, float]] = []
    for case in cases:
        result = await recall_fn(case)
        max_score = result.fragments[0].score if result.fragments else 0.0
        samples.append((case.must_find, max_score))
    return calibrate_tau(samples)
