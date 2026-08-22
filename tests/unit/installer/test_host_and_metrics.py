"""Host profile recommendation + eval metrics/calibration (pure)."""

from __future__ import annotations

import pytest
from evals.metrics import CaseOutcome, calibrate_tau, compute_eval_metrics

from rsc_brain.config.models import HardwareProfile
from rsc_brain.installer.host import detect_host, recommend_profile


def test_recommend_profile() -> None:
    assert recommend_profile(has_gpu=True) is HardwareProfile.WORKSTATION
    assert recommend_profile(has_gpu=False) is HardwareProfile.CPU_ONLY


def test_detect_host_runs_and_recommends() -> None:
    report = detect_host(ports=(65535,))
    assert report.recommended_profile in {"workstation", "cpu_only"}
    assert isinstance(report.docker, bool)
    assert 65535 in report.free_ports


def test_eval_metrics_precision_abstention_and_leaks() -> None:
    outcomes = [
        CaseOutcome("h1", "hit", must_find=True, found=True, max_score=0.8, latency_ms=10),
        CaseOutcome("h2", "hit", must_find=True, found=False, max_score=0.3, latency_ms=12),
        CaseOutcome("a1", "abstain", must_find=False, found=False, max_score=0.2, latency_ms=8),
        # AUDIT-127: a denied case that ANSWERED with authorized content is an abstention failure and
        # not a leak; only `disclosed` makes it one. Both are represented here so the two cannot be
        # conflated again — measured on a cpu_only install, the old rule reported 11 leaks where the
        # real number of disclosures was zero.
        CaseOutcome(
            "d1",
            "denied",
            must_find=False,
            found=True,
            max_score=0.9,
            latency_ms=9,
            disclosed=True,
        ),
        CaseOutcome(
            "d2",
            "denied",
            must_find=False,
            found=True,
            max_score=0.7,
            latency_ms=11,
            disclosed=False,
        ),
    ]
    report = compute_eval_metrics(outcomes)
    assert report.total == 5
    assert report.retrieval_precision == 0.5  # 1 of 2 must-find found
    assert report.correct_abstention_rate == pytest.approx(1 / 3)  # 1 of 3 must-abstain abstained
    assert report.permission_leaks == 1  # only d1 disclosed; d2 answered without disclosing
    assert report.avg_latency_ms == (10 + 12 + 8 + 9 + 11) / 5


def test_calibrate_tau_finds_separating_threshold() -> None:
    # must_find cases score high; must_abstain score low → τ between the clusters is best.
    samples = [(True, 0.8), (True, 0.75), (False, 0.2), (False, 0.25)]
    tau = calibrate_tau(samples, step=0.05)
    assert 0.25 < tau <= 0.75


def test_calibrate_tau_default_on_empty() -> None:
    assert calibrate_tau([]) == 0.45


def test_calibrate_tau_picks_the_middle_of_the_gap_not_its_edge() -> None:
    """AUDIT-132: among equally-perfect thresholds, choose the one furthest from either population.

    Measured on the corpus: with the v3 prompt, unanswerable pages score 0.0-0.1 and answers 0.9-1.0,
    so every τ in (0.1, 0.9) separates them perfectly. The sweep returned **0.11** — technically
    optimal on the sample and one noisy score away from wrong, while the configured 0.5 (which scores
    53/53) sits in the middle of the same gap.

    A threshold hugging the edge of a population is a number that is right about the data it was given
    and fragile about everything else.
    """
    samples = [(True, 0.9), (True, 0.95), (False, 0.05), (False, 0.1)]

    tau = calibrate_tau(samples)

    assert 0.4 < tau < 0.6, f"expected the middle of the 0.1-0.9 gap, got {tau}"


def test_calibrate_tau_still_separates_a_narrow_gap() -> None:
    """The cross-encoder's scale: answers at 0.34, siblings at 0.003 (AUDIT-131)."""
    samples = [(True, 0.34), (True, 0.30), (False, 0.003), (False, 0.01)]

    tau = calibrate_tau(samples)

    assert 0.01 < tau < 0.30, f"a threshold inside the gap, got {tau}"


def test_calibrate_tau_with_no_separating_threshold_still_answers() -> None:
    """Overlapping populations — the blended path's measured state — must not crash the sweep."""
    samples = [(True, 0.4), (False, 0.45), (True, 0.5), (False, 0.42)]

    tau = calibrate_tau(samples)

    assert 0.0 <= tau <= 1.0
