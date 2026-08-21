"""GraphStore k-hop benchmark (SPEC-09 E6.3, decision D1).

Builds a reproducible (fixed-seed) synthetic graph over the frozen ``GraphStore`` interface and
times a k-hop=2 traversal (p50/p95) against NFR-1 (≤1.5s workstation / ≤4s CPU-only). The 1M-edge
decision evidence is checked in; CI also runs a scaled-down graph to keep the lifecycle callable.
The verdict (keep AGE / activate Kuzu) is recorded in the harness ``decisions.md``.
"""

from __future__ import annotations

import csv
import datetime as dt
import hashlib
import json
import math
import time
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, model_validator

from rsc_brain.recall.retriever import PgRetriever
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.graph_store import GraphEdge, GraphNode, GraphStore

_RELATED = "RELATED"
DECISION_NODES = 200_000
DECISION_EDGES = 1_000_000
DECISION_SEED = 20260724
RELATION_LABELS = ("ASSERTS", "ABOUT", "SUPPORTS", "CONTRADICTS", "RELATED")
_PROFILE_THRESHOLDS_MS = {"workstation": 1500.0, "cpu_only": 4000.0}
_NODE_FILES = (("Entity", "nodes_entity.csv"), ("Claim", "nodes_claim.csv"))
_EDGE_FILES = tuple((label, f"edges_{label.lower()}.csv") for label in RELATION_LABELS)


class BenchmarkProfile(StrEnum):
    WORKSTATION = "workstation"
    CPU_ONLY = "cpu_only"


class GraphCounts(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")
    nodes: int = Field(ge=0)
    edges: int = Field(ge=0)


class WorkloadFileDigest(BaseModel):
    """Content identity and row count for one server-loadable CSV."""

    model_config = ConfigDict(frozen=True, extra="forbid")
    filename: str = Field(pattern=r"^[a-z][a-z0-9_]*\.csv$")
    kind: Literal["node", "edge"]
    label: str = Field(min_length=1)
    rows: int = Field(ge=0)
    size_bytes: int = Field(ge=1)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


def _workload_digest(
    *,
    counts: GraphCounts,
    seed: int,
    relation_labels: Sequence[str],
    files: Sequence[WorkloadFileDigest],
) -> str:
    payload = {
        "counts": counts.model_dump(mode="json"),
        "seed": seed,
        "relation_labels": list(relation_labels),
        "files": [item.model_dump(mode="json") for item in files],
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(canonical).hexdigest()


class WorkloadManifest(BaseModel):
    """Canonical identity of the exact CSV population loaded by every profile."""

    model_config = ConfigDict(frozen=True, extra="forbid")
    schema_version: Literal[1]
    counts: GraphCounts
    seed: int
    relation_labels: tuple[str, ...]
    files: tuple[WorkloadFileDigest, ...]
    workload_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def _is_exact_and_self_consistent(self) -> WorkloadManifest:
        if self.counts.nodes < 2 * len(self.relation_labels):
            raise ValueError("workload has too few nodes for its relation layers")
        if self.counts.edges != self.counts.nodes * len(self.relation_labels):
            raise ValueError("edge count must equal nodes multiplied by relation layers")
        if self.relation_labels != RELATION_LABELS:
            raise ValueError("relation labels disagree with the benchmark contract")
        expected = {
            *(("node", label, filename) for label, filename in _NODE_FILES),
            *(("edge", label, filename) for label, filename in _EDGE_FILES),
        }
        actual = {(item.kind, item.label, item.filename) for item in self.files}
        if actual != expected or len(actual) != len(self.files):
            raise ValueError("workload file set is incomplete, duplicated or unexpected")
        node_rows = sum(item.rows for item in self.files if item.kind == "node")
        edge_rows = sum(item.rows for item in self.files if item.kind == "edge")
        if node_rows != self.counts.nodes or edge_rows != self.counts.edges:
            raise ValueError("workload file rows disagree with declared counts")
        expected_digest = _workload_digest(
            counts=self.counts,
            seed=self.seed,
            relation_labels=self.relation_labels,
            files=self.files,
        )
        if self.workload_sha256 != expected_digest:
            raise ValueError("workload_sha256 disagrees with manifest content")
        return self


@dataclass(frozen=True, slots=True)
class PreparedWorkload:
    root: Path
    manifest: WorkloadManifest


class BackendLoadReport(BaseModel):
    """Backend-neutral result of reset, bulk load, indexes and exact count inspection."""

    model_config = ConfigDict(frozen=True, extra="forbid")
    persisted_counts: GraphCounts
    backend: str = Field(min_length=1)
    backend_version: str = Field(min_length=1)
    postgres_version: str = Field(min_length=1)
    load_seconds: float = Field(ge=0)


class BenchmarkLoader(Protocol):
    """Shared lifecycle seam implemented once by each candidate graph backend."""

    @property
    def graph_store(self) -> GraphStore: ...

    async def reset_load_count(
        self, scope: ProjectScope, prepared: PreparedWorkload
    ) -> BackendLoadReport: ...


class BenchmarkEnvironment(BaseModel):
    """Everything needed to distinguish and reproduce one profile run."""

    model_config = ConfigDict(frozen=True, extra="forbid")
    profile: BenchmarkProfile
    backend: str = Field(min_length=1)
    backend_version: str = Field(min_length=1)
    postgres_version: str = Field(min_length=1)
    image_identity: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    host_os: str = Field(min_length=1)
    host_arch: str = Field(min_length=1)
    host_cpu: str = Field(min_length=1)
    host_cpu_count: int = Field(ge=1)
    host_memory_bytes: int = Field(ge=1)
    container_cpu_limit: float = Field(gt=0)
    container_memory_bytes: int = Field(ge=1)
    accelerator: str = Field(min_length=1)


class DecisionRun(BaseModel):
    """One immutable, count-proven k-hop profile measurement."""

    model_config = ConfigDict(frozen=True, extra="forbid", allow_inf_nan=False)
    schema_version: Literal[1]
    decision_run: bool
    seed: int
    requested_counts: GraphCounts
    persisted_counts: GraphCounts
    relation_labels: tuple[str, ...]
    workload_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    k: int = Field(ge=1)
    start_ids: tuple[str, ...]
    warmups: int = Field(ge=0)
    iterations: int = Field(ge=1)
    raw_timings_ms: tuple[float, ...]
    p50_ms: float = Field(ge=0)
    p95_ms: float = Field(ge=0)
    threshold_ms: float = Field(gt=0)
    threshold_passed: bool
    load_seconds: float = Field(ge=0)
    environment: BenchmarkEnvironment

    @model_validator(mode="after")
    def _derived_fields_are_honest(self) -> DecisionRun:
        if len(self.raw_timings_ms) != self.iterations:
            raise ValueError("raw_timings_ms length must equal iterations")
        expected_p50 = _percentile(list(self.raw_timings_ms), 50)
        expected_p95 = _percentile(list(self.raw_timings_ms), 95)
        if abs(self.p50_ms - expected_p50) > 1e-9 or abs(self.p95_ms - expected_p95) > 1e-9:
            raise ValueError("p50_ms/p95_ms must be derived from raw_timings_ms")
        expected_threshold = _PROFILE_THRESHOLDS_MS[self.environment.profile.value]
        if self.threshold_ms != expected_threshold:
            raise ValueError("threshold_ms disagrees with profile")
        if self.threshold_passed != (self.p95_ms <= self.threshold_ms):
            raise ValueError("threshold_passed disagrees with p95_ms")
        return self


class DecisionArtifact(BaseModel):
    """Two measured profiles plus the only consequence their validated results permit."""

    model_config = ConfigDict(frozen=True, extra="forbid")
    schema_version: Literal[1]
    generated_at: dt.datetime
    runs: tuple[DecisionRun, ...]
    verdict: Literal["keep_age", "activate_kuzu"]

    @model_validator(mode="after")
    def _decision_matches_runs(self) -> DecisionArtifact:
        if self.generated_at.tzinfo is None:
            raise ValueError("generated_at must be timezone-aware")
        evaluation = evaluate_decision(self.runs)
        if evaluation.errors:
            raise ValueError("; ".join(evaluation.errors))
        if self.verdict != evaluation.verdict:
            raise ValueError("verdict disagrees with validated profile results")
        return self


@dataclass(frozen=True, slots=True)
class DecisionEvaluation:
    verdict: Literal["keep_age", "activate_kuzu"] | None
    errors: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class GraphWorkload:
    n_nodes: int
    n_edges: int
    seed: int
    relation_labels: tuple[str, ...] = RELATION_LABELS


@dataclass(frozen=True, slots=True)
class PlannedEdge:
    source_id: str
    target_id: str
    label: str


def decision_workload(*, seed: int = DECISION_SEED) -> GraphWorkload:
    return GraphWorkload(n_nodes=DECISION_NODES, n_edges=DECISION_EDGES, seed=seed)


def _coprime_stride(n_nodes: int, seed: int) -> int:
    candidate = seed % (n_nodes - 1) + 1
    while math.gcd(candidate, n_nodes) != 1:
        candidate = candidate % (n_nodes - 1) + 1
    return candidate


def iter_planned_edges(workload: GraphWorkload) -> Iterator[PlannedEdge]:
    """Stream exact unique directed edges; never allocate the million-edge population."""
    layers = len(workload.relation_labels)
    if workload.n_nodes < 2 * layers or workload.n_edges != workload.n_nodes * layers:
        raise ValueError("workload requires n_edges == n_nodes * relation-label count")
    stride = _coprime_stride(workload.n_nodes, workload.seed)
    for layer, label in enumerate(workload.relation_labels, start=1):
        for source in range(workload.n_nodes):
            target = (source + layer * stride) % workload.n_nodes
            yield PlannedEdge(source_id=f"e{source}", target_id=f"e{target}", label=label)


def deterministic_start_ids(workload: GraphWorkload) -> tuple[str, ...]:
    """Five evenly distributed starts, identical across backends and profile runs."""
    if workload.n_nodes < 5:
        raise ValueError("benchmark workload needs at least five start vertices")
    return tuple(f"e{index * workload.n_nodes // 5}" for index in range(5))


def _vertex_label(index: int, n_nodes: int) -> str:
    return "Entity" if index < n_nodes // 2 else "Claim"


def _digest_file(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            size += len(chunk)
            digest.update(chunk)
    return size, digest.hexdigest()


def _file_record(
    root: Path, *, filename: str, kind: Literal["node", "edge"], label: str, rows: int
) -> WorkloadFileDigest:
    size, sha256 = _digest_file(root / filename)
    return WorkloadFileDigest(
        filename=filename,
        kind=kind,
        label=label,
        rows=rows,
        size_bytes=size,
        sha256=sha256,
    )


def write_workload_files(root: Path, workload: GraphWorkload) -> PreparedWorkload:
    """Stream AGE-compatible CSVs and a canonical manifest without materialising the graph."""
    # Validate topology before opening any output, so an invalid request cannot leave partial files.
    if workload.n_nodes < 2 * len(workload.relation_labels):
        raise ValueError("workload has too few nodes for its relation layers")
    if workload.n_edges != workload.n_nodes * len(workload.relation_labels):
        raise ValueError("workload requires n_edges == n_nodes * relation-label count")
    if workload.relation_labels != RELATION_LABELS:
        raise ValueError("relation labels disagree with the benchmark contract")

    root.mkdir(parents=True, exist_ok=True)
    split = workload.n_nodes // 2
    node_ranges = ((0, split), (split, workload.n_nodes))
    records: list[WorkloadFileDigest] = []
    for (label, filename), (start, stop) in zip(_NODE_FILES, node_ranges, strict=True):
        path = root / filename
        with path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle, lineterminator="\n")
            writer.writerow(("id", "id"))
            for index in range(start, stop):
                writer.writerow((index + 1, f"e{index}"))
        records.append(
            _file_record(root, filename=filename, kind="node", label=label, rows=stop - start)
        )

    edge_handles = {
        label: (root / filename).open("w", encoding="utf-8", newline="")
        for label, filename in _EDGE_FILES
    }
    try:
        edge_writers = {
            label: csv.writer(handle, lineterminator="\n") for label, handle in edge_handles.items()
        }
        for writer in edge_writers.values():
            writer.writerow(("start_id", "start_vertex_type", "end_id", "end_vertex_type"))
        for edge in iter_planned_edges(workload):
            source = int(edge.source_id[1:])
            target = int(edge.target_id[1:])
            edge_writers[edge.label].writerow(
                (
                    source + 1,
                    _vertex_label(source, workload.n_nodes),
                    target + 1,
                    _vertex_label(target, workload.n_nodes),
                )
            )
    finally:
        for handle in edge_handles.values():
            handle.close()

    rows_per_label = workload.n_edges // len(workload.relation_labels)
    for label, filename in _EDGE_FILES:
        records.append(
            _file_record(root, filename=filename, kind="edge", label=label, rows=rows_per_label)
        )
    counts = GraphCounts(nodes=workload.n_nodes, edges=workload.n_edges)
    workload_sha256 = _workload_digest(
        counts=counts,
        seed=workload.seed,
        relation_labels=workload.relation_labels,
        files=records,
    )
    manifest = WorkloadManifest(
        schema_version=1,
        counts=counts,
        seed=workload.seed,
        relation_labels=workload.relation_labels,
        files=tuple(records),
        workload_sha256=workload_sha256,
    )
    (root / "workload-manifest.json").write_text(
        manifest.model_dump_json(indent=2) + "\n",
        encoding="utf-8",
    )
    return PreparedWorkload(root=root, manifest=manifest)


def load_workload_files(manifest_path: Path) -> PreparedWorkload:
    manifest = WorkloadManifest.model_validate_json(manifest_path.read_text(encoding="utf-8"))
    prepared = PreparedWorkload(root=manifest_path.parent, manifest=manifest)
    verify_workload_files(prepared)
    return prepared


def verify_workload_files(prepared: PreparedWorkload) -> None:
    """Refuse changed, missing or substituted CSVs before any backend lifecycle begins."""
    for expected in prepared.manifest.files:
        path = prepared.root / expected.filename
        if not path.is_file():
            raise ValueError(f"workload file is missing: {expected.filename}")
        size, sha256 = _digest_file(path)
        if size != expected.size_bytes or sha256 != expected.sha256:
            raise ValueError(f"workload file digest mismatch: {expected.filename}")


def validate_persisted_counts(workload: GraphWorkload, actual: GraphCounts) -> None:
    if actual.nodes != workload.n_nodes:
        raise ValueError(
            f"persisted node count {actual.nodes} does not match requested {workload.n_nodes}"
        )
    if actual.edges != workload.n_edges:
        raise ValueError(
            f"persisted edge count {actual.edges} does not match requested {workload.n_edges}"
        )


def evaluate_decision(runs: tuple[DecisionRun, ...]) -> DecisionEvaluation:
    errors: list[str] = []
    by_profile = {run.environment.profile: run for run in runs}
    if len(by_profile) != len(runs):
        errors.append("duplicate benchmark profile")
    if set(by_profile) != {BenchmarkProfile.WORKSTATION, BenchmarkProfile.CPU_ONLY}:
        errors.append("both profiles workstation and cpu_only are required")
    for run in runs:
        if not run.decision_run:
            errors.append(f"{run.environment.profile.value}: scaled smoke is not a decision run")
        if run.seed != DECISION_SEED:
            errors.append(f"{run.environment.profile.value}: seed differs from decision contract")
        if run.requested_counts != GraphCounts(nodes=DECISION_NODES, edges=DECISION_EDGES):
            errors.append(f"{run.environment.profile.value}: workload is not 1M edges")
        if run.persisted_counts != run.requested_counts:
            errors.append(f"{run.environment.profile.value}: persisted counts differ")
        if run.relation_labels != RELATION_LABELS:
            errors.append(f"{run.environment.profile.value}: relation labels differ")
        expected_starts = deterministic_start_ids(decision_workload(seed=run.seed))
        if run.k != 2 or run.start_ids != expected_starts:
            errors.append(f"{run.environment.profile.value}: k/start-set policy differs")
        if run.warmups != 5 or run.iterations != 30:
            errors.append(f"{run.environment.profile.value}: warm-up/iteration policy incomplete")
        # Resource declarations are part of the decision contract, not descriptive prose.
        env = run.environment
        if env.profile is BenchmarkProfile.WORKSTATION and (
            env.container_cpu_limit < 8 or env.container_memory_bytes < 8_000_000_000
        ):
            errors.append("workstation: resource profile is below 8 vCPU/8 GB")
        if env.profile is BenchmarkProfile.CPU_ONLY and (
            env.container_cpu_limit != 4 or env.container_memory_bytes < 6 * 1024**3
        ):
            errors.append("cpu_only: resource profile must be 4 vCPU/6 GiB")
    if len(runs) == 2:
        first, second = runs
        if first.seed != second.seed or first.workload_sha256 != second.workload_sha256:
            errors.append("profiles did not measure the same seeded workload")
        if (
            first.environment.backend != second.environment.backend
            or first.environment.backend_version != second.environment.backend_version
            or first.environment.postgres_version != second.environment.postgres_version
            or first.environment.image_identity != second.environment.image_identity
        ):
            errors.append("profiles did not measure the same backend/version/image")
    if errors:
        return DecisionEvaluation(verdict=None, errors=tuple(errors))
    verdict: Literal["keep_age", "activate_kuzu"] = (
        "keep_age" if all(run.threshold_passed for run in runs) else "activate_kuzu"
    )
    return DecisionEvaluation(verdict=verdict, errors=())


def combine_decision_runs(
    runs: tuple[DecisionRun, ...], *, generated_at: dt.datetime | None = None
) -> DecisionArtifact:
    evaluation = evaluate_decision(runs)
    if evaluation.errors or evaluation.verdict is None:
        raise ValueError("; ".join(evaluation.errors))
    return DecisionArtifact(
        schema_version=1,
        generated_at=generated_at or dt.datetime.now(dt.UTC),
        runs=runs,
        verdict=evaluation.verdict,
    )


@dataclass(frozen=True, slots=True)
class GraphSpec:
    node_ids: list[str]
    edge_count: int
    seed: int


@dataclass(frozen=True, slots=True)
class BenchmarkResult:
    n_edges: int
    n_nodes: int
    k: int
    iterations: int
    p50_ms: float
    p95_ms: float

    def as_dict(self) -> dict[str, object]:
        return {
            "n_edges": self.n_edges,
            "n_nodes": self.n_nodes,
            "k": self.k,
            "iterations": self.iterations,
            "p50_ms": round(self.p50_ms, 2),
            "p95_ms": round(self.p95_ms, 2),
        }


def plan_graph(*, n_edges: int, seed: int) -> tuple[list[str], list[tuple[str, str]]]:
    """Plan the legacy scaled smoke without duplicate or self edges.

    Full decision runs use :func:`iter_planned_edges`, which streams labels and never allocates the
    population. This compatibility helper deliberately remains bounded to the small CI smoke.
    """
    n_nodes = max(10, math.ceil(n_edges / 5))
    if n_edges > n_nodes * (n_nodes - 1):
        raise ValueError("requested edge population cannot be unique without self edges")
    node_ids = [f"e{i}" for i in range(n_nodes)]
    # Hash first so adjacent small seeds do not converge while searching for the same next coprime.
    legacy_seed = int.from_bytes(hashlib.sha256(str(seed).encode()).digest()[:8])
    stride = _coprime_stride(n_nodes, legacy_seed)
    layer_count = math.ceil(n_edges / n_nodes)
    offsets: list[int] = []
    for layer in range(1, layer_count + 1):
        candidate = (seed % n_nodes + layer * stride) % n_nodes
        while candidate == 0 or candidate in offsets:
            candidate = (candidate + 1) % n_nodes
        offsets.append(candidate)
    edges: list[tuple[str, str]] = []
    for index in range(n_edges):
        layer = index // n_nodes + 1
        source = index % n_nodes
        target = (source + offsets[layer - 1]) % n_nodes
        edges.append((node_ids[source], node_ids[target]))
    return node_ids, edges


async def generate_synthetic_graph(
    graph: AgeGraphStore, scope: ProjectScope, *, n_edges: int, seed: int, batch: int = 500
) -> GraphSpec:
    """Populate the project graph with a reproducible synthetic Entity graph."""
    node_ids, edges = plan_graph(n_edges=n_edges, seed=seed)
    await graph.create_graph(scope)
    nodes = [
        GraphNode(id=nid, labels=frozenset({"Entity"}), properties={"i": nid}) for nid in node_ids
    ]
    for start in range(0, len(nodes), batch):
        await graph.upsert_nodes(scope, nodes[start : start + batch])
    graph_edges = [GraphEdge(source_id=a, target_id=b, type=_RELATED) for a, b in edges]
    for start in range(0, len(graph_edges), batch):
        await graph.upsert_edges(scope, graph_edges[start : start + batch])
    return GraphSpec(node_ids=node_ids, edge_count=n_edges, seed=seed)


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, round(pct / 100.0 * (len(ordered) - 1)))
    return ordered[index]


async def benchmark_khop(
    graph: GraphStore,
    scope: ProjectScope,
    spec: GraphSpec,
    *,
    k: int = 2,
    iterations: int = 10,
    fanout: int = 5,
) -> BenchmarkResult:
    """Time k-hop=k over ``iterations`` runs from a fixed set of start nodes."""
    start_ids = spec.node_ids[:fanout]
    timings: list[float] = []
    for _ in range(iterations):
        began = time.monotonic()
        await graph.k_hop(scope, start_ids, k=k)
        timings.append((time.monotonic() - began) * 1000.0)
    return BenchmarkResult(
        n_edges=spec.edge_count,
        n_nodes=len(spec.node_ids),
        k=k,
        iterations=iterations,
        p50_ms=_percentile(timings, 50),
        p95_ms=_percentile(timings, 95),
    )


async def measure_khop_run(
    graph: GraphStore,
    scope: ProjectScope,
    *,
    workload: GraphWorkload,
    persisted_counts: GraphCounts,
    workload_sha256: str,
    load_seconds: float,
    environment: BenchmarkEnvironment,
    decision_run: bool,
    warmups: int = 5,
    iterations: int = 30,
    k: int = 2,
    timer: Callable[[], float] = time.perf_counter,
) -> DecisionRun:
    """Measure only the frozen traversal seam; loading and counting remain backend adapters."""
    validate_persisted_counts(workload, persisted_counts)
    start_ids = deterministic_start_ids(workload)
    for _ in range(warmups):
        await graph.k_hop(scope, start_ids, k=k)

    timings: list[float] = []
    for _ in range(iterations):
        began = timer()
        await graph.k_hop(scope, start_ids, k=k)
        timings.append((timer() - began) * 1000.0)

    p50_ms = _percentile(timings, 50)
    p95_ms = _percentile(timings, 95)
    threshold_ms = _PROFILE_THRESHOLDS_MS[environment.profile.value]
    return DecisionRun(
        schema_version=1,
        decision_run=decision_run,
        seed=workload.seed,
        requested_counts=GraphCounts(nodes=workload.n_nodes, edges=workload.n_edges),
        persisted_counts=persisted_counts,
        relation_labels=workload.relation_labels,
        workload_sha256=workload_sha256,
        k=k,
        start_ids=start_ids,
        warmups=warmups,
        iterations=iterations,
        raw_timings_ms=tuple(timings),
        p50_ms=p50_ms,
        p95_ms=p95_ms,
        threshold_ms=threshold_ms,
        threshold_passed=p95_ms <= threshold_ms,
        load_seconds=load_seconds,
        environment=environment,
    )


@dataclass(frozen=True, slots=True)
class AsOfBenchmarkResult:
    """`as_of` reconstruction latency (SPEC-17, FR-16.4) — measured on the same footing as the D1
    k-hop benchmark (NFR-1: p95 ≤1.5s GPU / ≤4s CPU). The 1M-edge run is the same documented
    manual/nightly job; CI runs a scaled-down history to prove the measurement is reproducible."""

    iterations: int
    p50_ms: float
    p95_ms: float

    def as_dict(self) -> dict[str, object]:
        return {
            "iterations": self.iterations,
            "p50_ms": round(self.p50_ms, 2),
            "p95_ms": round(self.p95_ms, 2),
        }


async def benchmark_as_of(
    retriever: PgRetriever,
    scope: ProjectScope,
    *,
    query: str,
    as_of: dt.date,
    iterations: int = 10,
) -> AsOfBenchmarkResult:
    """Time the `as_of` reconstruction path (vector + k-hop within the as-of subgraph) over
    ``iterations`` runs. The bitemporal index backs the validity cut (verified by EXPLAIN in the
    time-travel integration suite)."""
    timings: list[float] = []
    for _ in range(iterations):
        began = time.monotonic()
        await retriever.recall(scope, query, as_of=as_of)
        timings.append((time.monotonic() - began) * 1000.0)
    return AsOfBenchmarkResult(
        iterations=iterations,
        p50_ms=_percentile(timings, 50),
        p95_ms=_percentile(timings, 95),
    )
