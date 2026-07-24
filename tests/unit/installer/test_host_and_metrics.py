"""Host profile recommendation + eval metrics/calibration (pure)."""

from __future__ import annotations

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
        CaseOutcome("d1", "denied", must_find=False, found=True, max_score=0.9, latency_ms=9),
    ]
    report = compute_eval_metrics(outcomes)
    assert report.total == 4
    assert report.retrieval_precision == 0.5  # 1 of 2 must-find found
    assert report.correct_abstention_rate == 0.5  # 1 of 2 must-abstain abstained
    assert report.permission_leaks == 1  # the denied case leaked
    assert report.avg_latency_ms == (10 + 12 + 8 + 9) / 4


def test_calibrate_tau_finds_separating_threshold() -> None:
    # must_find cases score high; must_abstain score low → τ between the clusters is best.
    samples = [(True, 0.8), (True, 0.75), (False, 0.2), (False, 0.25)]
    tau = calibrate_tau(samples, step=0.05)
    assert 0.25 < tau <= 0.75


def test_calibrate_tau_default_on_empty() -> None:
    assert calibrate_tau([]) == 0.45
