"""Golden-set eval runner (PRD §12): run each case through recall, time it, aggregate metrics.

The runner is transport-agnostic — it takes a ``recall_fn`` that maps a case to a
:class:`~rsc_brain.recall.interfaces.RecallResult` (the caller wires the per-case user scope). A
full run over ``golden.yaml`` against a live model is blocked-by-resource; the runner + metrics are
exercised in CI with the deterministic gateway.
"""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass

from evals.metrics import CaseOutcome, EvalReport, calibrate_tau, compute_eval_metrics
from rsc_brain.recall.interfaces import RecallResult


@dataclass(frozen=True, slots=True)
class EvalCase:
    case_id: str
    family: str
    must_find: bool


RecallFn = Callable[[EvalCase], Awaitable[RecallResult]]


async def run_eval(cases: Sequence[EvalCase], recall_fn: RecallFn) -> EvalReport:
    """Run every case through ``recall_fn``, measuring latency, and aggregate the §12 report."""
    outcomes: list[CaseOutcome] = []
    for case in cases:
        start = time.monotonic()
        result = await recall_fn(case)
        latency_ms = (time.monotonic() - start) * 1000.0
        max_score = result.fragments[0].score if result.fragments else 0.0
        outcomes.append(
            CaseOutcome(
                case_id=case.case_id,
                family=case.family,
                must_find=case.must_find,
                found=result.found,
                max_score=max_score,
                latency_ms=latency_ms,
            )
        )
    return compute_eval_metrics(outcomes)


async def run_calibration(cases: Sequence[EvalCase], recall_fn: RecallFn) -> float:
    """Recall every case (the caller passes a τ=0 retriever so all return a top score) and return
    the τ that maximizes abstention F1 (D2)."""
    samples: list[tuple[bool, float]] = []
    for case in cases:
        result = await recall_fn(case)
        max_score = result.fragments[0].score if result.fragments else 0.0
        samples.append((case.must_find, max_score))
    return calibrate_tau(samples)
