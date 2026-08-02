# Interface freeze

The interfaces below were frozen on 2026-07-24. Their signatures and listed semantics are internal
extension contracts: changing one requires a one-page RFC approved before implementation, plus
contract tests and migration guidance in the same change.

| Contract | Module | Frozen guarantee |
|---|---|---|
| `ProjectScope` and `Principal` | `rsc_brain.scope` | Identity and one project form an immutable authority; delegation intersects topics without changing project. |
| `GraphStore` | `rsc_brain.stores.graph_store` | Graph work receives scope first; Cypher parameters and project separation remain part of the boundary. |
| `VectorStore` | `rsc_brain.stores.vector_store` | Search and writes receive scope first; project and topic filters are applied in the query; vectors use dimension 1024. |
| `RelationalStore` and `KnowledgeRepository` | `rsc_brain.stores.relational.repository` | Knowledge methods receive scope first; schema migration remains a separate lifecycle step. |
| `Channel` | `rsc_brain.hunting.channel` | Outbound knowledge hunting remains project-scoped and reply tokens remain single-purpose. |
| `Retriever.recall` | `rsc_brain.recall.interfaces` | The first argument is `ProjectScope`; no independent `project_id` argument exists. |
| `Ingestor.ingest` and `RawSource` | `rsc_brain.ingest.interfaces` | Inputs carry project ownership and cross-project mismatch is rejected before side effects. |
| `ModelGateway` | `rsc_brain.gateway.model_gateway` | Routing is configuration-owned, generation options are typed, and provider errors are redacted. |

## Project-scope invariant

`ProjectScope` binds the authenticated principal to one project. Frozen storage, ingestion, and
recall methods take that scope before project-owned input. Implementations call `require` or
`require_object` before a query or mutation when an input also carries ownership.

A mismatch raises `CrossProjectScopeError` with the constant message `not found`. The message does
not reveal the other project. Delegation keeps the agent principal type and current project while
intersecting the agent's topics with the human member's topics.

`tests/unit/stores/test_frozen_interfaces.py` asserts the signatures, immutability, delegation, and
constant-error behavior.

## Change process

1. Write the problem, proposed contract, compatibility impact, and migration in a one-page RFC.
2. Obtain approval before editing the frozen signature or guarantee.
3. Update the interface, implementations, contract tests, this page, and public release notes
   together.
4. Prove both permitted behavior and project/topic denial behavior at the affected boundary.
