# Development runbook

Use this page when changing the rsc-brain repository. The public
[contributing guide](../CONTRIBUTING.md) defines submission and review requirements; this runbook
adds a source map and focused commands.

## Set up the repository

```bash
uv sync --all-groups
uv run brain --version
uv run pytest
uv run ruff check .
uv run mypy
```

Python 3.12 is required. Console work also needs Node.js 22:

```bash
cd apps/admin
npm ci
npm run typecheck
```

## Source map

| Path | Responsibility |
|---|---|
| `src/rsc_brain/api/` | FastAPI application, REST routes, OAuth, authentication, and request limits |
| `src/rsc_brain/mcp/` | Streamable HTTP MCP server, tools, PAT authentication, and quotas |
| `src/rsc_brain/cli/` | Typer command tree and structured command output |
| `src/rsc_brain/config/` | Typed configuration and environment overlay |
| `src/rsc_brain/ingest/` | Source storage, extraction pipeline, review policy, and durable queue |
| `src/rsc_brain/recall/` | Hybrid retrieval, temporal selection, and permission-filtered fragments |
| `src/rsc_brain/knowledge/` | Feedback, corrections, contradictions, and erasure |
| `src/rsc_brain/stores/` | Relational, pgvector, and Apache AGE boundaries |
| `src/rsc_brain/identity/` | Users, projects, memberships, topics, credentials, and delegation |
| `src/rsc_brain/gateway/` | Capability-owned model routing, usage, budgets, and embedding cache |
| `src/rsc_brain/hunting/` | Knowledge gaps, people, delivery channels, and replies |
| `src/rsc_brain/ontology/` | Optional RDF ontology parsing and anchoring |
| `apps/admin/` | Next.js administration console and generated OpenAPI client types |
| `deploy/` | Production Compose, platform overlays, Helm chart, and route parity |
| `docker/` | PostgreSQL 16 + AGE + pgvector image |
| `evals/` | Synthetic corpus, metrics, calibration, and fixture generation |
| `tests/` | Unit, integration, permission, deployment, and edge contracts |
| `docs/` | Public tutorials, task guides, references, explanations, and runbooks |

## Common checks

| Change | Commands |
|---|---|
| Python behavior | `uv run pytest` and the affected integration tests |
| Python style and types | `uv run ruff check .`, `uv run ruff format --check src tests`, `uv run mypy` |
| Public documentation | `uv run python scripts/check_docs.py` and `uv run pytest tests/unit/test_documentation.py` |
| REST contract | `uv run python scripts/export_openapi.py`, then inspect `apps/admin/openapi.json` |
| Console | `npm run gen:api`, `npm run lint`, `npm run typecheck`, `npm run build` in `apps/admin` |
| Dependencies | `uv run pip-audit`, `uv run python scripts/check_licenses.py`, and production `npm audit` |
| Full data layer | Real PostgreSQL 16 + AGE + pgvector integration suite |
| Deployment | Caddy edge traversal, Compose/Helm parity, Helm lint, and rendered-schema validation |

The default pytest selection excludes tests marked `integration`. Never report an environment-
dependent check as passing when it was skipped.

## Load-bearing invariants

- Carry identity and project together as `ProjectScope`; do not accept a separate project selector
  at a knowledge boundary.
- Apply topic authorization inside the query that produces content, counts, ordering, pagination,
  graph state, exports, or model context.
- Keep hidden and absent private objects externally indistinguishable when existence is sensitive.
- Route models only through typed configuration. Request data cannot choose providers, endpoints,
  credentials, or fallback models.
- Treat source documents, retrieved fragments, model output, paths, URLs, and parser input as
  untrusted data.
- Preserve idempotency and convergence across retries, concurrent decisions, and cross-store work.
- Change a frozen interface only after an approved one-page RFC; see
  [Interface Freeze](interface-freeze.md).

## Documentation rule

Documentation claims must describe observable behavior in the same revision. Update the relevant
tutorial, task guide, reference, explanation, deployment page, and changelog when their contract
moves. `scripts/check_docs.py` verifies local navigation, privacy boundaries, current-state language,
Diátaxis markers, and coverage of generated REST, CLI, MCP, and configuration inventories.
