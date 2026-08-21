"""AUDIT-106: graph document expansion is live-edge-only, cyclic-safe and bounded."""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from unittest.mock import AsyncMock

import pytest

from rsc_brain.config.models import RecallConfig
from rsc_brain.recall.retriever import MAX_RETRIEVAL_WIDTH, PgRetriever
from rsc_brain.scope import Principal, PrincipalType, ProjectScope


class _ScriptedGraph:
    def __init__(self, responses: list[list[Mapping[str, object]]]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, Mapping[str, object]]] = []

    async def run_cypher(
        self, scope: ProjectScope, cypher: str, params: Mapping[str, object]
    ) -> list[Mapping[str, object]]:
        del scope
        self.calls.append((cypher, params))
        return self.responses[len(self.calls) - 1]


def _scope() -> ProjectScope:
    return Principal(id=str(uuid.uuid4()), type=PrincipalType.HUMAN).scope_for(str(uuid.uuid4()))


def _retriever(graph: _ScriptedGraph, *, k_hop: int) -> PgRetriever:
    retriever = object.__new__(PgRetriever)
    retriever._graph = graph  # type: ignore[assignment]
    retriever._config = RecallConfig(k_hop=k_hop)
    return retriever


async def test_neighbor_document_hops_name_and_filter_each_edge_and_stop_on_a_cycle() -> None:
    graph = _ScriptedGraph(
        responses=[
            [{"result": "doc-b"}, {"result": "doc-b"}],
            [{"result": "doc-a"}],
        ]
    )
    retriever = _retriever(graph, k_hop=3)

    result = await retriever._neighbor_documents(_scope(), {"doc-a"})

    assert result == {"doc-b"}
    assert [call[1]["docs"] for call in graph.calls] == [["doc-a"], ["doc-b"]]
    assert all("MATCH (a)-[r]-(b)" in call[0] for call in graph.calls)
    assert all("r.superseded IS NULL" in call[0] for call in graph.calls)
    assert all(f"LIMIT {MAX_RETRIEVAL_WIDTH}" in call[0] for call in graph.calls)
    assert all("[*" not in call[0] for call in graph.calls)


async def test_neighbor_document_graph_failure_degrades_to_no_expansion() -> None:
    graph = _ScriptedGraph([])
    graph.run_cypher = AsyncMock(side_effect=RuntimeError("AGE unavailable"))  # type: ignore[method-assign]
    retriever = _retriever(graph, k_hop=1)

    result = await retriever._neighbor_documents(_scope(), {"doc-a"})

    assert result == set()


async def test_expanded_candidate_ids_cannot_exceed_the_recall_ceiling(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    retriever = _retriever(_ScriptedGraph([]), k_hop=1)
    expanded = [str(uuid.uuid4()) for _ in range(MAX_RETRIEVAL_WIDTH + 50)]
    monkeypatch.setattr(retriever, "_documents_of", AsyncMock(return_value={"seed-doc"}))
    monkeypatch.setattr(
        retriever,
        "_neighbor_documents",
        AsyncMock(return_value={"seed-doc", "expanded-doc"}),
    )
    monkeypatch.setattr(
        retriever,
        "_visible_chunks_of_documents",
        AsyncMock(return_value=expanded),
    )

    result = await retriever._expand_k_hop(_scope(), frozenset(), ["seed-chunk"])

    assert len(result) == MAX_RETRIEVAL_WIDTH
    assert result[0] == "seed-chunk"
    assert result[1:] == expanded[: MAX_RETRIEVAL_WIDTH - 1]
