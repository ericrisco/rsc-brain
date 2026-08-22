"""Eval metrics + τ calibration (PRD §12), pure functions over recall outcomes.

``brain eval`` reports retrieval precision, correct-abstention rate, permission leaks, and
latency; ``brain calibrate`` sweeps τ to maximize the abstention F1 on the golden set. Kept pure
(no I/O) so the metrics are unit-testable; the runner that produces the per-case outcomes lives in
the CLI (recall over the ingested corpus).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

# Families whose expected answer is a *security* abstention. Returning anything is a FAILURE; only
# returning content the principal is not authorized for is a LEAK (AUDIT-127).
SECURITY_ABSTAIN_FAMILIES = {"denied", "cross_project"}


@dataclass(frozen=True, slots=True)
class CaseOutcome:
    """One golden case run through recall."""

    case_id: str
    family: str
    must_find: bool
    found: bool
    max_score: float
    latency_ms: float
    # ``None`` preserves the historic found/not-found interpretation for legacy callers that
    # construct outcomes directly. The runner always supplies the structured verdict.
    passed: bool | None = None
    failures: tuple[str, ...] = ()
    #: Whether a fragment carrying a topic this principal is not authorized for was returned.
    #: ``None`` means the caller did not supply the forbidden set, so nothing is claimed either way:
    #: absence of the input is not evidence of a breach, nor of safety (AUDIT-090's rule, applied to
    #: the metric that most needs it).
    disclosed: bool | None = None


@dataclass(frozen=True, slots=True)
class EvalReport:
    total: int
    retrieval_precision: float
    correct_abstention_rate: float
    permission_leaks: int
    avg_latency_ms: float

    def as_dict(self) -> dict[str, object]:
        return {
            "total": self.total,
            "retrieval_precision": round(self.retrieval_precision, 4),
            "correct_abstention_rate": round(self.correct_abstention_rate, 4),
            "permission_leaks": self.permission_leaks,
            "avg_latency_ms": round(self.avg_latency_ms, 2),
        }


def compute_eval_metrics(outcomes: Sequence[CaseOutcome]) -> EvalReport:
    """Aggregate per-case outcomes into the §12 report."""
    must_find = [o for o in outcomes if o.must_find]
    must_abstain = [o for o in outcomes if not o.must_find]
    precision = sum(_passed(o) for o in must_find) / len(must_find) if must_find else 1.0
    abstention = sum(_passed(o) for o in must_abstain) / len(must_abstain) if must_abstain else 1.0
    # AUDIT-127: this counted every security-family case that returned anything. Measured on a
    # cpu_only install, that reported **11 permission leaks** where the real number of disclosures was
    # **zero** — eleven abstention failures, no confidentiality breach, because the permission filter
    # is in the query and holds with or without the reranker. Wrong in both directions: a fire drill
    # over a leak that does not exist, and a real disclosure among the eleven would not move the
    # number. Answering-when-it-should-abstain is already reported by `correct_abstention_rate`.
    leaks = sum(
        1
        for o in outcomes
        if o.family in SECURITY_ABSTAIN_FAMILIES and not o.must_find and o.disclosed
    )
    latency = sum(o.latency_ms for o in outcomes) / len(outcomes) if outcomes else 0.0
    return EvalReport(
        total=len(outcomes),
        retrieval_precision=precision,
        correct_abstention_rate=abstention,
        permission_leaks=leaks,
        avg_latency_ms=latency,
    )


def _passed(outcome: CaseOutcome) -> bool:
    """Use structured observations when present, retaining the historical metric otherwise."""
    if outcome.passed is not None:
        return outcome.passed
    return outcome.found if outcome.must_find else not outcome.found


def _abstention_f1(samples: Sequence[tuple[bool, float]], tau: float) -> float:
    """F1 of the 'abstain' decision (predict abstain iff max_score < τ) against ground truth
    (should-abstain iff not must_find)."""
    tp = fp = fn = 0
    for must_find, max_score in samples:
        predicted_abstain = max_score < tau
        should_abstain = not must_find
        if predicted_abstain and should_abstain:
            tp += 1
        elif predicted_abstain and not should_abstain:
            fp += 1
        elif not predicted_abstain and should_abstain:
            fn += 1
    if tp == 0:
        return 0.0
    precision = tp / (tp + fp)
    recall = tp / (tp + fn)
    return 2 * precision * recall / (precision + recall)


def calibrate_tau(samples: Sequence[tuple[bool, float]], *, step: float = 0.01) -> float:
    """Sweep τ in [0, 1] and return the value maximizing abstention F1 (D2). ``samples`` are
    ``(must_find, max_score)`` from recall run with τ=0 (so every case yields a raw top score)."""
    if not samples:
        return 0.45
    best_tau, best_f1 = 0.0, -1.0
    steps = round(1.0 / step)
    for i in range(steps + 1):
        tau = i * step
        f1 = _abstention_f1(samples, tau)
        if f1 > best_f1:
            best_f1, best_tau = f1, tau
    return round(best_tau, 4)
