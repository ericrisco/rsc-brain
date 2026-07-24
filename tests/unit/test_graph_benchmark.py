"""Reproducible graph planning + percentile (SPEC-09 E6.3, pure)."""

from __future__ import annotations

from evals.graph_benchmark import _percentile, plan_graph


def test_plan_graph_is_reproducible_for_a_seed() -> None:
    nodes_a, edges_a = plan_graph(n_edges=300, seed=42)
    nodes_b, edges_b = plan_graph(n_edges=300, seed=42)
    assert nodes_a == nodes_b
    assert edges_a == edges_b
    assert len(edges_a) == 300


def test_plan_graph_differs_by_seed() -> None:
    _, edges_a = plan_graph(n_edges=300, seed=1)
    _, edges_b = plan_graph(n_edges=300, seed=2)
    assert edges_a != edges_b


def test_percentile() -> None:
    values = [float(i) for i in range(1, 101)]  # 1..100
    # nearest-rank on the zero-based index round(pct/100 * (n-1))
    assert _percentile(values, 50) == 51.0
    assert _percentile(values, 95) == 95.0
    assert _percentile(values, 0) == 1.0
    assert _percentile(values, 100) == 100.0
    assert _percentile([], 95) == 0.0
    assert _percentile([42.0], 95) == 42.0
