"""Contract tests for the frozen interfaces and the AUDIT-003 project-scope invariant."""

from __future__ import annotations

import inspect
from collections.abc import Callable
from typing import Any

import pytest

from rsc_brain.ingest.interfaces import Ingestor, RawSource
from rsc_brain.recall.interfaces import Retriever
from rsc_brain.scope import (
    CrossProjectScopeError,
    Principal,
    PrincipalType,
    ScopeError,
)
from rsc_brain.stores.graph_store import GraphStore
from rsc_brain.stores.relational.repository import KnowledgeRepository
from rsc_brain.stores.vector_store import VectorRecord, VectorStore


def _param_names(method: Callable[..., Any]) -> list[str]:
    return [p for p in inspect.signature(method).parameters if p != "self"]


def _human(**kw: Any) -> Principal:
    return Principal(id="u1", type=PrincipalType.HUMAN, **kw)


# --- ProjectScope binds identity to exactly one project (AUDIT-003) ---


def test_scope_for_binds_identity_and_project() -> None:
    scope = _human(allowed_topics=frozenset({"hr"})).scope_for("proj-a")
    assert scope.principal_id == "u1"
    assert scope.project_id == "proj-a"
    assert scope.authorizes("proj-a")
    assert not scope.authorizes("proj-b")


def test_require_rejects_other_project_before_side_effect() -> None:
    scope = _human().scope_for("proj-a")
    scope.require("proj-a")  # same project: passes
    with pytest.raises(CrossProjectScopeError):
        scope.require("proj-b")


def test_require_object_rejects_cross_project_owned_input() -> None:
    scope = _human().scope_for("proj-a")
    foreign = RawSource(project_id="proj-b", source_id="s1", uri="file://x", checksum="abc")
    with pytest.raises(CrossProjectScopeError):
        scope.require_object(foreign)
    # a same-project record is accepted
    own = VectorRecord(chunk_id="c1", project_id="proj-a", embedding=[0.0])
    scope.require_object(own)


def test_cross_project_error_is_indistinguishable() -> None:
    # Forbidden vs nonexistent must be byte-identical (FR-4.3): constant message.
    e1 = CrossProjectScopeError()
    e2 = CrossProjectScopeError()
    assert str(e1) == str(e2) == "not found"


# --- delegation intersects permissions and never changes the project (SPEC-11) ---


def test_delegation_intersects_and_keeps_project() -> None:
    human = _human(allowed_topics=frozenset({"hr", "finance"}), can_curate=True).scope_for("proj-a")
    agent = Principal(id="a1", type=PrincipalType.AGENT, allowed_topics=frozenset({"finance"}))
    delegated = human.delegate_to(agent)
    assert delegated.project_id == "proj-a"  # never broadened/changed
    assert delegated.allowed_topics == frozenset({"finance"})  # intersection
    assert delegated.principal_type is PrincipalType.AGENT
    assert delegated.on_behalf_of == "u1"
    assert delegated.can_curate is False  # agent cannot curate


def test_delegation_requires_agent_target() -> None:
    human = _human().scope_for("proj-a")
    with pytest.raises(ScopeError):
        human.delegate_to(_human())  # a human is not a valid delegate


# --- frozen signatures expose no independent project_id (AUDIT-003) ---


def test_recall_signature_takes_scope_not_project_id() -> None:
    params = _param_names(Retriever.recall)
    assert params[0] == "scope"
    assert "project_id" not in params
    assert "ProjectScope" in str(inspect.signature(Retriever.recall).parameters["scope"].annotation)


def test_ingest_signature_takes_scope_not_project_id() -> None:
    params = _param_names(Ingestor.ingest)
    assert params[0] == "scope"
    assert "project_id" not in params


@pytest.mark.parametrize(
    "method",
    [
        VectorStore.search,
        VectorStore.upsert,
        GraphStore.k_hop,
        GraphStore.run_cypher,
        KnowledgeRepository.get_document,
        KnowledgeRepository.count_documents,
    ],
)
def test_store_methods_take_scope_first_and_no_bare_project_id(method: Callable[..., Any]) -> None:
    params = _param_names(method)
    assert params[0] == "scope"
    assert "project_id" not in params


def test_project_scope_is_immutable() -> None:
    scope = _human().scope_for("proj-a")
    with pytest.raises((AttributeError, TypeError)):
        scope.project_id = "proj-b"  # type: ignore[misc]
