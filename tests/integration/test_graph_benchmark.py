"""Scaled-down k-hop benchmark against the real AGE container (SPEC-09 E6.3, AC#6).

Proves the generator is reproducible and the k-hop=2 timer produces p50/p95 against the frozen
``GraphStore``. The 1M-edge NFR-1 run is a documented manual job; here we run a small graph so CI
stays fast while exercising the exact measurement path.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest
from evals.graph_benchmark import benchmark_khop, generate_synthetic_graph

from rsc_brain.stores.age_graph_store import AgeGraphStore

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

_EDGES = 200
_SEED = 7


async def test_benchmark_is_reproducible_and_measures_khop(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    graph = AgeGraphStore(harness.sm)
    project_id = await harness.setup_project(unique_slug("bench"), topics=[])
    scope = harness.scope(project_id)

    spec = await generate_synthetic_graph(graph, scope, n_edges=_EDGES, seed=_SEED)
    assert spec.edge_count == _EDGES
    # Every planned node is materialised in the project graph.
    assert await harness.graph_node_count(scope) == len(spec.node_ids)

    result = await benchmark_khop(graph, scope, spec, k=2, iterations=6)
    assert result.n_edges == _EDGES
    assert result.k == 2
    assert result.p50_ms >= 0.0
    assert result.p95_ms >= result.p50_ms
    assert set(result.as_dict()) == {"n_edges", "n_nodes", "k", "iterations", "p50_ms", "p95_ms"}

    # k-hop is deterministic for a fixed graph + start set (same neighbourhood every call).
    first = await graph.k_hop(scope, spec.node_ids[:5], k=2)
    second = await graph.k_hop(scope, spec.node_ids[:5], k=2)
    assert {n.id for n in first} == {n.id for n in second}


async def test_same_seed_yields_same_node_count_in_a_fresh_graph(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    graph = AgeGraphStore(harness.sm)
    scope_a = harness.scope(await harness.setup_project(unique_slug("bench-a"), topics=[]))
    scope_b = harness.scope(await harness.setup_project(unique_slug("bench-b"), topics=[]))

    spec_a = await generate_synthetic_graph(graph, scope_a, n_edges=_EDGES, seed=_SEED)
    spec_b = await generate_synthetic_graph(graph, scope_b, n_edges=_EDGES, seed=_SEED)

    assert spec_a.node_ids == spec_b.node_ids
    assert await harness.graph_node_count(scope_a) == await harness.graph_node_count(scope_b)
