"""Guard: every knowledge repository method must require a ProjectScope (FR-12.4 / AUDIT-003).

This fails the build if any knowledge operation is invocable without a scope, or accepts a
bare ``project_id`` — the PR auto-reject surface for cross-project isolation.
"""

from __future__ import annotations

import inspect

from rsc_brain.stores.relational.repositories import KnowledgeRepository


def test_every_knowledge_method_requires_project_scope() -> None:
    methods = [
        name
        for name in dir(KnowledgeRepository)
        if not name.startswith("_") and callable(getattr(KnowledgeRepository, name))
    ]
    assert methods, "KnowledgeRepository exposes no methods"
    for name in methods:
        signature = inspect.signature(getattr(KnowledgeRepository, name))
        params = [p for p in signature.parameters if p != "self"]
        assert params, f"{name} takes no arguments; a knowledge op must take a ProjectScope"
        assert params[0] == "scope", f"{name}'s first argument must be 'scope', got {params[0]!r}"
        assert "project_id" not in params, f"{name} must not accept a bare project_id"
        annotation = str(signature.parameters["scope"].annotation)
        assert "ProjectScope" in annotation, f"{name}'s scope must be a ProjectScope"
