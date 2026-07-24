# Interface Freeze — SPEC-01 (E0.2 / FR-2.2)

> **Frozen: 2026-07-24.** These public contracts are stable. Changing any signature or
> semantic guarantee below requires a **one-page RFC approved before the change** (SPECS
> Master §1.2). This document is the freeze act referenced by the developer runbook
> ([docs/AGENTS.md](AGENTS.md)).

## What is frozen

| Contract | Module | Guarantee |
|---|---|---|
| `ProjectScope` / `Principal` | `rsc_brain.scope` | Identity + project are one indivisible authority (AUDIT-003). |
| `GraphStore` | `rsc_brain.stores.graph_store` | One graph per project; parameterized Cypher; k-hop. Backend swappable to Kuzu (D1). |
| `VectorStore` | `rsc_brain.stores.vector_store` | Project + tag filter **in the query**; embedding dim anchored 1024. |
| `RelationalStore`, `KnowledgeRepository` | `rsc_brain.stores.relational.repository` | Every knowledge method takes `ProjectScope` first. `migrate` is a separate step. |
| `Channel` | `rsc_brain.hunting.channel` | Project-scoped send; magic-link reply token. |
| `Retriever.recall` | `rsc_brain.recall.interfaces` | Takes `ProjectScope`, **not** a bare `project_id`. |
| `Ingestor.ingest` + `RawSource` | `rsc_brain.ingest.interfaces` | Project-owned inputs; cross-project rejected before side effects. |
| `ModelGateway` | `rsc_brain.gateway.model_gateway` | Immutable routing; typed generation options; redacted errors (AUDIT-005). |

## The load-bearing invariant (AUDIT-003)

The authenticated identity and the project it is authorized for are a **single unit**
(`ProjectScope`). No frozen interface accepts a `project_id` independently of that scope:

- `Retriever.recall(scope, query, ...)` — the project comes from `scope`. There is no
  `project_id` parameter, so a caller cannot combine a principal for project A with project B.
- Store methods take `scope`; project-owned records/sources carry their own `project_id` and
  implementations must call `ProjectScope.require_object(obj)` **before** any query/write.
  Mismatch raises `CrossProjectScopeError`, whose message is constant so forbidden and
  nonexistent are indistinguishable (FR-4.3).
- Delegation (`ProjectScope.delegate_to(agent)`) intersects permissions and **never** changes
  or broadens the project (SPEC-11 `on_behalf_of`).

Contract tests in `tests/unit/stores/test_frozen_interfaces.py` assert these invariants,
including that `recall`/`ingest` signatures expose no independent `project_id` parameter.

## Change process

1. Open a one-page RFC describing the change and its migration.
2. Get it approved (the freeze rule is a project non-negotiable).
3. Update this document, the affected module, and the contract tests in the same change.
