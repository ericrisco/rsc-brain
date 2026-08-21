"""AUDIT-011: only a measured, exact million-edge two-profile run may decide D1."""

from __future__ import annotations

import hashlib
from dataclasses import replace
from pathlib import Path
from typing import cast

import pytest
from evals.graph_benchmark import (
    DECISION_EDGES,
    DECISION_NODES,
    BenchmarkEnvironment,
    BenchmarkProfile,
    DecisionRun,
    GraphCounts,
    GraphWorkload,
    combine_decision_runs,
    decision_workload,
    deterministic_start_ids,
    evaluate_decision,
    iter_planned_edges,
    measure_khop_run,
    plan_graph,
    validate_persisted_counts,
    verify_workload_files,
    write_workload_files,
)

from rsc_brain.scope import Principal, PrincipalType
from rsc_brain.stores.graph_store import GraphNode, GraphStore


def _environment(profile: BenchmarkProfile) -> BenchmarkEnvironment:
    return BenchmarkEnvironment(
        profile=profile,
        backend="apache-age",
        backend_version="1.6.0",
        postgres_version="16.10",
        image_identity="sha256:" + "a" * 64,
        host_os="Darwin",
        host_arch="arm64",
        host_cpu="Apple M4 Pro",
        host_cpu_count=12,
        host_memory_bytes=24 * 1024**3,
        container_cpu_limit=8.0 if profile is BenchmarkProfile.WORKSTATION else 4.0,
        container_memory_bytes=(8 if profile is BenchmarkProfile.WORKSTATION else 6) * 1024**3,
        accelerator="Apple GPU (not used by PostgreSQL/AGE)",
    )


def _run(
    profile: BenchmarkProfile, *, decision_run: bool = True, p95_ms: float = 10.0
) -> DecisionRun:
    threshold = 1500.0 if profile is BenchmarkProfile.WORKSTATION else 4000.0
    return DecisionRun(
        schema_version=1,
        decision_run=decision_run,
        seed=20260724,
        requested_counts=GraphCounts(nodes=DECISION_NODES, edges=DECISION_EDGES),
        persisted_counts=GraphCounts(nodes=DECISION_NODES, edges=DECISION_EDGES),
        relation_labels=("ASSERTS", "ABOUT", "SUPPORTS", "CONTRADICTS", "RELATED"),
        workload_sha256="b" * 64,
        k=2,
        start_ids=("e0", "e40000", "e80000", "e120000", "e160000"),
        warmups=5,
        iterations=30,
        raw_timings_ms=tuple([p95_ms] * 30),
        p50_ms=p95_ms,
        p95_ms=p95_ms,
        threshold_ms=threshold,
        threshold_passed=p95_ms <= threshold,
        load_seconds=12.5,
        environment=_environment(profile),
    )


def test_decision_workload_has_exact_unique_non_self_edges_without_materialising_a_list() -> None:
    workload = decision_workload(seed=20260724)

    assert workload.n_nodes == 200_000
    assert workload.n_edges == 1_000_000
    assert not isinstance(iter_planned_edges(workload), list)

    small = replace(workload, n_nodes=20, n_edges=100)
    edges = list(iter_planned_edges(small))
    identities = {(edge.source_id, edge.label, edge.target_id) for edge in edges}
    assert len(edges) == len(identities) == 100
    assert all(edge.source_id != edge.target_id for edge in edges)
    assert edges == list(iter_planned_edges(small))

    _, smoke_edges = plan_graph(n_edges=100, seed=20260724)
    assert len(smoke_edges) == len(set(smoke_edges)) == 100
    assert all(source != target for source, target in smoke_edges)


def test_persisted_count_mismatch_refuses_the_measurement() -> None:
    workload = decision_workload(seed=20260724)

    with pytest.raises(ValueError, match="persisted edge count"):
        validate_persisted_counts(
            workload,
            GraphCounts(nodes=workload.n_nodes, edges=workload.n_edges - 1),
        )


def test_scaled_smoke_cannot_be_promoted_to_a_d1_decision() -> None:
    workstation = _run(BenchmarkProfile.WORKSTATION, decision_run=False)
    cpu = _run(BenchmarkProfile.CPU_ONLY)

    errors = evaluate_decision((workstation, cpu)).errors

    assert any("scaled smoke" in error for error in errors)

    wrong_seed = workstation.model_copy(update={"decision_run": True, "seed": 17})
    assert any("seed differs" in error for error in evaluate_decision((wrong_seed, cpu)).errors)


def test_both_profiles_are_required_and_an_nfr_miss_activates_kuzu() -> None:
    workstation = _run(BenchmarkProfile.WORKSTATION)
    incomplete = evaluate_decision((workstation,))
    assert any("both profiles" in error for error in incomplete.errors)

    cpu_miss = _run(BenchmarkProfile.CPU_ONLY, p95_ms=4100.0)
    decision = evaluate_decision((workstation, cpu_miss))
    assert decision.errors == ()
    assert decision.verdict == "activate_kuzu"


def test_profile_resources_and_immutable_image_identity_are_not_prose_only() -> None:
    workstation = _run(BenchmarkProfile.WORKSTATION)
    weak_environment = workstation.environment.model_copy(update={"container_cpu_limit": 7.0})
    weak = workstation.model_copy(update={"environment": weak_environment})
    cpu = _run(BenchmarkProfile.CPU_ONLY)

    assert any("below 8 vCPU" in error for error in evaluate_decision((weak, cpu)).errors)

    different_image = cpu.environment.model_copy(update={"image_identity": "sha256:" + "d" * 64})
    changed = cpu.model_copy(update={"environment": different_image})
    assert any(
        "same backend/version/image" in error
        for error in evaluate_decision((workstation, changed)).errors
    )


def test_two_exact_passing_profiles_support_retaining_age() -> None:
    decision = evaluate_decision(
        (_run(BenchmarkProfile.WORKSTATION), _run(BenchmarkProfile.CPU_ONLY))
    )

    assert decision.errors == ()
    assert decision.verdict == "keep_age"


def test_combined_artifact_rejects_forged_starts_and_records_observed_branch() -> None:
    workstation = _run(BenchmarkProfile.WORKSTATION)
    forged = workstation.model_copy(update={"start_ids": ("e1",) * 5})

    with pytest.raises(ValueError, match="start-set policy"):
        combine_decision_runs((forged, _run(BenchmarkProfile.CPU_ONLY)))

    artifact = combine_decision_runs(
        (_run(BenchmarkProfile.WORKSTATION), _run(BenchmarkProfile.CPU_ONLY, p95_ms=4100.0))
    )
    assert artifact.verdict == "activate_kuzu"


def test_streamed_csv_workload_has_stable_file_and_manifest_hashes(tmp_path: Path) -> None:
    workload = GraphWorkload(n_nodes=20, n_edges=100, seed=20260724)

    first = write_workload_files(tmp_path / "first", workload)
    second = write_workload_files(tmp_path / "second", workload)

    assert first.manifest == second.manifest
    assert first.manifest.counts == GraphCounts(nodes=20, edges=100)
    assert sum(item.rows for item in first.manifest.files if item.kind == "node") == 20
    assert sum(item.rows for item in first.manifest.files if item.kind == "edge") == 100
    verify_workload_files(first)
    assert len(first.manifest.files) == 7

    for item in first.manifest.files:
        payload = (first.root / item.filename).read_bytes()
        assert item.size_bytes == len(payload)
        assert item.sha256 == hashlib.sha256(payload).hexdigest()


def test_modified_workload_file_is_refused_before_load(tmp_path: Path) -> None:
    prepared = write_workload_files(
        tmp_path,
        GraphWorkload(n_nodes=20, n_edges=100, seed=7),
    )
    changed = prepared.root / prepared.manifest.files[0].filename
    changed.write_text(changed.read_text(encoding="utf-8") + "21,e20\n", encoding="utf-8")

    with pytest.raises(ValueError, match="digest mismatch"):
        verify_workload_files(prepared)


class _PortableFakeGraph:
    def __init__(self) -> None:
        self.calls: list[tuple[tuple[str, ...], int]] = []

    async def k_hop(self, scope: object, start_ids: tuple[str, ...], *, k: int) -> list[GraphNode]:
        self.calls.append((tuple(start_ids), k))
        return []


async def test_timed_path_uses_only_graphstore_khop_and_enforces_five_plus_thirty() -> None:
    graph = _PortableFakeGraph()
    workload = GraphWorkload(n_nodes=20, n_edges=100, seed=7)
    ticks = iter(value / 1000 for value in range(0, 61))
    scope = Principal(
        id="11111111-1111-1111-1111-111111111111",
        type=PrincipalType.HUMAN,
    ).scope_for("22222222-2222-2222-2222-222222222222")

    run = await measure_khop_run(
        cast(GraphStore, graph),
        scope,
        workload=workload,
        persisted_counts=GraphCounts(nodes=20, edges=100),
        workload_sha256="c" * 64,
        load_seconds=1.0,
        environment=_environment(BenchmarkProfile.CPU_ONLY),
        decision_run=False,
        timer=lambda: next(ticks),
    )

    expected_starts = deterministic_start_ids(workload)
    assert len(graph.calls) == 35
    assert graph.calls == [(expected_starts, 2)] * 35
    assert run.warmups == 5
    assert run.iterations == 30
    assert len(run.raw_timings_ms) == 30
    assert run.p50_ms == pytest.approx(1.0)
    assert run.p95_ms == pytest.approx(1.0)
