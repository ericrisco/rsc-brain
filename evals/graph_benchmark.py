"""GraphStore k-hop benchmark (SPEC-09 E6.3, decision D1).

Builds a reproducible (fixed-seed) synthetic graph over the frozen ``GraphStore`` interface and
times a k-hop=2 traversal (p50/p95) against NFR-1 (≤1.5s GPU / ≤4s CPU). The 1M-edge run is a
documented manual/nightly job; CI runs a scaled-down graph to prove reproducibility + measurement.
The verdict (keep AGE / activate Kuzu) is recorded in the harness ``decisions.md``.
"""

from __future__ import annotations

import datetime as dt
import random
import time
from dataclasses import dataclass

from rsc_brain.recall.retriever import PgRetriever
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.graph_store import GraphEdge, GraphNode

_RELATED = "RELATED"


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
    """Deterministically plan nodes + edges for a given seed (pure — reproducible)."""
    n_nodes = max(10, n_edges // 5)
    node_ids = [f"e{i}" for i in range(n_nodes)]
    rng = random.Random(seed)
    edges = [
        (node_ids[rng.randrange(n_nodes)], node_ids[rng.randrange(n_nodes)]) for _ in range(n_edges)
    ]
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
    graph: AgeGraphStore,
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
