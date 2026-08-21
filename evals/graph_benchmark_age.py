"""Apache AGE bulk-load adapter for the backend-neutral D1 benchmark lifecycle."""

from __future__ import annotations

import time
from pathlib import PurePosixPath

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from evals.graph_benchmark import (
    BackendLoadReport,
    GraphCounts,
    GraphWorkload,
    PreparedWorkload,
    validate_persisted_counts,
    verify_workload_files,
)
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore, graph_name, safe_identifier
from rsc_brain.stores.graph_store import GraphStore

_SET_SEARCH_PATH = 'SET search_path = ag_catalog, "$user", public'


class AgeCsvBenchmarkLoader:
    """Reset and load AGE through its documented CSV functions, never internal tables.

    The database-side directory is operator configuration. Only the seven fixed filenames from a
    validated workload manifest are appended to it, so no benchmark input can select an arbitrary
    server file.
    """

    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        server_csv_root: str,
    ) -> None:
        raw_parts = server_csv_root.split("/")
        root = PurePosixPath(server_csv_root)
        if (
            not server_csv_root.startswith("/")
            or root == PurePosixPath("/")
            or ".." in raw_parts
            or "." in raw_parts
        ):
            raise ValueError("server_csv_root must be a confined absolute directory")
        self._sm = sessionmaker
        self._server_root = root
        self._graph = AgeGraphStore(sessionmaker)

    @property
    def graph_store(self) -> GraphStore:
        return self._graph

    def _server_path(self, filename: str) -> str:
        # WorkloadManifest has already limited filenames to the exact seven-file contract.
        return str(self._server_root / filename)

    async def reset_load_count(
        self, scope: ProjectScope, prepared: PreparedWorkload
    ) -> BackendLoadReport:
        verify_workload_files(prepared)
        graph = safe_identifier(graph_name(scope.project_id))
        started = time.perf_counter()
        await self._graph.drop_graph(scope)
        await self._graph.create_graph(scope)

        async with self._sm() as session:
            await session.execute(text("LOAD 'age'"))
            await session.execute(text(_SET_SEARCH_PATH))
            for item in prepared.manifest.files:
                path = self._server_path(item.filename)
                if item.kind == "node":
                    await session.execute(
                        text(
                            "SELECT ag_catalog.load_labels_from_file("
                            "CAST(:graph AS name), CAST(:label AS name), :path, true, true)"
                        ),
                        {"graph": graph, "label": item.label, "path": path},
                    )
                else:
                    await session.execute(
                        text(
                            "SELECT ag_catalog.load_edges_from_file("
                            "CAST(:graph AS name), CAST(:label AS name), :path, true)"
                        ),
                        {"graph": graph, "label": item.label, "path": path},
                    )

            for label in ("Entity", "Claim"):
                safe_label = safe_identifier(label)
                await session.execute(
                    text(
                        f'CREATE INDEX ON "{graph}"."{safe_label}" '
                        "(ag_catalog.agtype_access_operator(properties, '\"id\"'::agtype))"
                    )
                )
                await session.execute(text(f'ANALYZE "{graph}"."{safe_label}"'))
            await session.commit()

        persisted = await self._persisted_counts(scope)
        workload = GraphWorkload(
            n_nodes=prepared.manifest.counts.nodes,
            n_edges=prepared.manifest.counts.edges,
            seed=prepared.manifest.seed,
            relation_labels=prepared.manifest.relation_labels,
        )
        validate_persisted_counts(workload, persisted)

        async with self._sm() as session:
            age_version = await session.scalar(
                text("SELECT extversion FROM pg_extension WHERE extname = 'age'")
            )
            postgres_version = await session.scalar(text("SHOW server_version"))
        if not isinstance(age_version, str) or not isinstance(postgres_version, str):
            raise RuntimeError("AGE/PostgreSQL version metadata is unavailable")
        return BackendLoadReport(
            persisted_counts=persisted,
            backend="apache-age",
            backend_version=age_version,
            postgres_version=postgres_version,
            load_seconds=time.perf_counter() - started,
        )

    async def _persisted_counts(self, scope: ProjectScope) -> GraphCounts:
        node_rows = await self._graph.run_cypher(
            scope,
            "MATCH (n) RETURN count(n) AS result",
            {},
        )
        edge_rows = await self._graph.run_cypher(
            scope,
            "MATCH ()-[r]->() RETURN count(r) AS result",
            {},
        )
        nodes = node_rows[0]["result"] if node_rows else None
        edges = edge_rows[0]["result"] if edge_rows else None
        if not isinstance(nodes, int) or not isinstance(edges, int):
            raise RuntimeError("AGE did not return integer persisted graph counts")
        return GraphCounts(nodes=nodes, edges=edges)
