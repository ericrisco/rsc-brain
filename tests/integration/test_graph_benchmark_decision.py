"""Official AGE CSV loading proves persisted counts before the portable timed path."""

from __future__ import annotations

from pathlib import Path

import pytest
from evals.graph_benchmark import GraphCounts, GraphWorkload, write_workload_files
from evals.graph_benchmark_age import AgeCsvBenchmarkLoader
from testcontainers.community.postgres import PostgresContainer

from rsc_brain.scope import Principal, PrincipalType
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker

pytestmark = pytest.mark.integration

_IMAGE = "rsc-brain/db:pg16-age-pgvector"
_PASSWORD = "benchmark-strong-pw-abc123"


async def test_official_age_loader_persists_exact_mixed_graph_and_runs_k2(tmp_path: Path) -> None:
    workload = GraphWorkload(n_nodes=20, n_edges=100, seed=20260724)
    prepared = write_workload_files(tmp_path / "csv", workload)
    container = (
        PostgresContainer(
            _IMAGE,
            username="rsc_brain",
            password=_PASSWORD,
            dbname="rsc_brain",
        )
        .with_command("postgres -c shared_preload_libraries=age")
        .with_volume_mapping(prepared.root, "/benchmark", "ro")
    )

    with container as running:
        host = running.get_container_host_ip()
        port = running.get_exposed_port(5432)
        dsn = f"postgresql+asyncpg://rsc_brain:{_PASSWORD}@{host}:{port}/rsc_brain"
        engine = make_engine(dsn)
        sessions = make_sessionmaker(engine)
        loader = AgeCsvBenchmarkLoader(sessions, server_csv_root="/benchmark")
        scope = Principal(
            id="11111111-1111-1111-1111-111111111111",
            type=PrincipalType.HUMAN,
        ).scope_for("22222222-2222-2222-2222-222222222222")
        try:
            report = await loader.reset_load_count(scope, prepared)
            neighbours = await loader.graph_store.k_hop(scope, ("e0",), k=2)
        finally:
            await engine.dispose()

    assert report.persisted_counts == GraphCounts(nodes=20, edges=100)
    assert report.backend == "apache-age"
    assert report.backend_version
    assert report.postgres_version
    assert neighbours
    assert all(node.id.startswith("e") for node in neighbours)
