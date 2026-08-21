"""The checked-in D1 evidence must remain complete, derived and tied to its workload."""

from __future__ import annotations

from pathlib import Path

from evals.graph_benchmark import (
    DECISION_EDGES,
    DECISION_NODES,
    BenchmarkProfile,
    DecisionArtifact,
    WorkloadManifest,
)

_ROOT = Path(__file__).parents[2]
_RESULT = _ROOT / "evals/results/graph-decision-2026-08-21.json"
_MANIFEST = _ROOT / "evals/results/graph-decision-workload-manifest.json"


def test_checked_in_decision_is_full_scale_count_proven_and_manifest_bound() -> None:
    manifest = WorkloadManifest.model_validate_json(_MANIFEST.read_text(encoding="utf-8"))
    artifact = DecisionArtifact.model_validate_json(_RESULT.read_text(encoding="utf-8"))

    assert manifest.counts.nodes == DECISION_NODES
    assert manifest.counts.edges == DECISION_EDGES
    assert {run.environment.profile for run in artifact.runs} == {
        BenchmarkProfile.WORKSTATION,
        BenchmarkProfile.CPU_ONLY,
    }
    assert all(run.persisted_counts == manifest.counts for run in artifact.runs)
    assert all(run.workload_sha256 == manifest.workload_sha256 for run in artifact.runs)
    assert all(run.threshold_passed for run in artifact.runs)
    assert artifact.verdict == "keep_age"
