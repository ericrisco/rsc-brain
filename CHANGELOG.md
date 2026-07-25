# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> "Added" entries describe capabilities whose behaviour is observable and verifiable **in the
> same commit** (per AUDIT-002). Planned-but-unbuilt work is not listed as added.

## [Unreleased]

## [0.2.0] - 2026-07-25

Everything merged into `main` up to this point ships here — the 0.1.0 line was never released — with
the P0-A batch of the audit-remediation program as the change that justifies the minor bump: it
tightens authorization and migrates the schema, so it is a behavioural break for any caller that
relied on the old gates.

### Changed — P0-A: shared authority and read isolation (audit-remediation-master, T002)

- **One decision point for authority.** `rsc_brain.authorization.decide` answers a *named operation*
  against the ratified AUDIT-020 matrix, and `ProjectScope` carries the two authorities that were
  conflated: the project membership role and the platform role. **Breaking:** a platform
  owner/admin no longer reaches project content without an explicit membership, and `can_curate`
  authorizes only knowledge-review decisions — not project, ontology, logging, gap, export,
  document-lifecycle or platform operations (R03/R04).
- **Topic visibility is in the query.** Console reads, counters, aggregates and the CSV export are
  filtered before a row, a total or a page exists: the activity aggregate, the review-queue counters
  and the audit export previously shared the unfiltered query with the list beside them (R01).
  `/api/v1/admin/projects` no longer enumerates other tenants' slugs.
- **Document decisions require the lifecycle capability.** `POST /api/v1/documents/{id}/approve` and
  `/reject` had no capability check at all; both entry points now take the same decision over the
  document's topics plus any tag being applied (R02).
- **Knowledge writes are intersected with topic authority** before persistence; a tag outside it is
  refused rather than dropped (R05). A claim outside the caller's topic visibility is neither
  readable nor mutable and answers exactly like a nonexistent one (R06). Correction attribution
  derives from the scope's validated delegation, never from a client-supplied `on_behalf_of` (R15).
- **`/metrics` is an operator surface.** It had no authorization dependency; it now requires the
  operator capability, which no project role satisfies. The four tenant-derived totals it published
  moved to the authorized project dashboard (R10).
- **Model usage is per project.** `token_usage` counted per (capability, day) for the whole instance,
  so each tenant read the pooled total as its own and one project's traffic exhausted another's
  budget. `brain usage` gains `--project`; without it, it is explicitly the operator view (R12).
- **Entity-graph views are permission-first.** Authority is applied to the whole candidate
  neighbourhood before counting and paging, and claims now carry the deterministic entity identity
  the graph node does, so a visible claim about one identity never authorizes a same-named other
  (R16).

### Added

- `brain preflight` — a read-only report of data that would block a schema upgrade (cross-project
  references), so an operator decides ownership instead of a migration guessing (R17).

### Fixed

- All 15 tenant-owned foreign keys are project-qualified `(project_id, child) -> parent (project_id,
  id)`, enforced by the database, so a write that bypasses the service layer can no longer attach one
  project's child to another project's parent (R17).

### Migrations

`d5b1f7c3a920` (project-bound usage), `e6c2a9f4b715` (project-qualified references — blocks with a
per-relation report if pre-existing cross-project rows exist; run `brain preflight` first),
`f7d3b1e8c204` (deterministic entity identity on claims).

### Added — Sprint 0 / SPEC-02 (foundational content)

- **Prompts v1** (`src/rsc_brain/prompts/`): extractor cascade (entities → relations → claims),
  topicalizer, and the LLM contradiction judge — English with a language-preservation instruction
  (D5), ≥3 ES/EN few-shot each, and an explicit **untrusted-data precedence block** so document
  content can never inject instructions (AUDIT-008).
- **Hunting templates** (4 × ES/EN) at the canonical `src/rsc_brain/hunting/templates/` (AUDIT-009).
- **Eval corpus** (`evals/`): a 2-project synthetic taxonomy; 27 documents (prose/tables/scanned/
  sensitive, all four D13 policies incl. retained-sensitive, temporal fact-with-history, exact-id
  invoice/NIF); `golden.yaml` (44 cases across hit/abstain/denied/cross_project/exact_id/temporal/
  injection); `contradictions.yaml` (32 ES/EN pairs, all verdicts). A pydantic-backed validator
  checks paths + manifest completeness; a generator renders the corpus to PDFs.
- The **PRD-§12 `brain eval` rule** documented in `evals/README.md`. (Local-model prompt
  iteration is `blocked-by-resource` — no Ollama on this host.)

### Added — v0.1 / SPEC-04 (identity, permissions, audit)

- **Credentials**: argon2id passwords; `ck_`/`inv_` bearer tokens stored only as SHA-256 hashes
  (`security.py`).
- **Identity service**: projects (bootstrap `default`, not deletable), invitation → argon2
  activation (single-use), memberships + topics, PATs, and **service-account agents** with their
  own identity + service PAT. Migration **0002** adds the `agents` table and lets a PAT reference
  a membership **or** an agent (exactly-one).
- **Scope resolution** (`resolve_scope`): a bearer token maps to a `ProjectScope` via a direct DB
  lookup (no cache), so revoking/disabling a token/user/agent takes effect immediately (<5s).
  The project is never taken from client input (FR-12.3).
- **Permission enforcement** (`recall/permissions.py`): the FR-4.14 restrictive rule is applied
  **in the query** — a chunk carrying a sensitive tag (`sensitivity >= threshold`) the caller
  does not own is excluded (overlap is not enough). Denied ≡ nonexistent (FR-4.3).
- **Audit** (`audit.py`): one row per action with the agent fields (`principal_type`,
  `principal_id`, `on_behalf_of`, `trace_id`); `brain audit` query + CSV export.
- **`brain doctor`**: hardcoded-secret scan of config (FR-4.7).
- **Admin CLI**: `brain projects` / `users` / `topics` / `audit` / `doctor`.
- **Isolation suite** (`tests/permissions_suite/`): synthetic 2-project seed proving FR-4.14 and
  hard cross-project isolation against a real container; re-run against MCP in SPEC-06 for the
  full gate-v0.1 "0 leaks".

### Added — v0.1 / SPEC-03 (data layer)

- **Schema + migrations**: SQLAlchemy 2.0 async models for the full PRD §5.2 data model
  (20 tables); async Alembic with the initial migration creating the `vector`/`age`
  extensions, every knowledge/operation table with `project_id NOT NULL` + a composite index,
  and HNSW cosine indexes on chunk/claim embeddings. `brain migrate` applies to head
  (idempotent).
- **RelationalStore** + project-scoped `KnowledgeRepository` (`ProjectScope` mandatory on every
  method — a bare `project_id` is impossible) + global `UserRepository`; forbidden and
  nonexistent are indistinguishable (FR-4.3).
- **VectorStore** (pgvector): similarity search with the project + allowed-tags filter embedded
  in the SQL (cosine over HNSW), never post-hoc (FR-4.2/12.4).
- **GraphStore** (Apache AGE): one physical graph per project; all node/edge data flows through
  parameterized Cypher (labels/edge-types are validated identifiers — no data interpolation);
  k-hop; property tombstone (`suppressed`).
- **`brain backup` / `restore` / `forget --document`**: single-artifact `pg_dump` backup;
  restore + migrate + verify; hard-delete a document (chunks/claims/embeddings cascade) + graph
  tombstone + audit entry, idempotent.
- All three stores are proven against a real Postgres 16 + Apache AGE + pgvector container
  (testcontainers), including hard multiproject isolation.

### Added — Sprint 0 / SPEC-01 (repository bootstrap, in progress)

- Project skeleton following PRD §11, packaged with **uv** (Python 3.12); `ruff` (lint +
  format), `mypy --strict`, `pytest`, and `pre-commit` configured.
- Tracked publication boundary (`.gitignore`) inherited by every worktree (AUDIT-010).
- **12-factor configuration** layer (`rsc_brain.config`): YAML file + environment overlay via
  pydantic-settings; `config.example.yaml` carries no secrets.
- **Frozen interfaces**: `GraphStore`, `VectorStore`, `RelationalStore`/`KnowledgeRepository`,
  `Channel`, and the public `recall`/`ingest` signatures. Authenticated identity and project
  scope are one indivisible `ProjectScope`; cross-project mismatch is rejected before any side
  effect (AUDIT-003). See `docs/interface-freeze.md`.
- **`brain` CLI** skeleton (Typer): all FR-10.1 subcommands with a global `--json` flag;
  unimplemented commands exit non-zero with a structured `not_implemented` payload.
- **Model gateway** (`rsc_brain.gateway`) over LiteLLM: per-capability provider config;
  structured completion with validate → repair → fallback; embedding dimension anchoring
  (1024); a real per-capability `healthcheck`. Routing (model/endpoint/credentials/timeout/
  fallback) is immutable from call data and provider errors are redacted (AUDIT-005).
- **Data-service Compose** stack: Postgres 16 + Apache AGE 1.6.0 + pgvector 0.8.5 in one
  image. Base pinned by digest, pgvector built from a verified commit; ports loopback-bound;
  `POSTGRES_PASSWORD` required and re-validated before boot; runs as non-root (uid 999);
  healthchecked. Verified: image builds and both extensions load (AUDIT-007).
- **CI/release** (GitHub Actions): lint + types + tests, `pip-audit` SCA, AGPL license audit,
  ephemeral-compose AGE/pgvector smoke; release SBOM (syft) + CVE scan (grype). Every action
  is pinned to a full commit SHA, workflow tokens are least-privilege, and Dependabot proposes
  SHA bumps (AUDIT-006).
- **OSS health**: SECURITY.md (honest scanner inventory), CONTRIBUTING.md, issue/PR templates,
  and the development runbook (`docs/AGENTS.md` / `docs/CLAUDE.md`).

[Unreleased]: https://github.com/ericrisco/rsc-brain/commits/main
