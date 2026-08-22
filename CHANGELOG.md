# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> "Added" entries describe capabilities whose behaviour is observable and verifiable **in the
> same commit** (per AUDIT-002). Planned-but-unbuilt work is not listed as added.

## [Unreleased]

## [0.14.0] - 2026-08-22

### Added

- Added the console Hunting Directory and Skill Lifecycle contracts: immutable topic-scoped hunts,
  minimized person collections with dependency-aware versioned deletion, and audited optimistic
  skill validation/archive commands with durable replay semantics.
- Added a Diátaxis-based public documentation set for installation, first use, operations,
  configuration, REST, MCP, security, architecture, and troubleshooting.
- Added executable documentation, MCP transport, platform-overlay, and Helm regression checks.

### Changed

- Migrated the MCP knowledge surface to SDK 2.0. The per-principal skill catalogue now resolves
  through a server middleware, because `list_tools()` no longer receives the request context, and
  the transport posture (DNS-rebinding allow-list, stateless mode) is applied where 2.0 accepts it —
  when the ASGI app is built — while remaining owned by the composition root.
- Released chart schema `0.14.0`: top-level Helm `extraEnv` now reaches only API and worker;
  console-only values move to `console.extraEnv`. Application images remain at `0.13.0`.

### Security

- Remediated the admin lockfile's current high `js-yaml`, `brace-expansion`, and Redocly findings;
  full-lock npm audit and pinned OSV now fail CI across the Python and npm dependency graphs.
- Replaced global secret-literal suppression with reasoned line-local fixtures and four exact
  historical fingerprints, and added explicit three-day Dependabot cooldowns for every configured
  ecosystem including the admin console.

### Fixed

- Served streamable HTTP MCP at the documented `/mcp` path and retained DNS-rebinding protection
  for the canonical configured public origin, including strict Host, Origin, and port boundaries.
- Validated and canonicalized `ingress.public_origin` before OAuth, hunting, and MCP consume it.
- Made Coolify route both surfaces on one origin without cross-project Traefik object collisions,
  and connected Dokploy's exposed services to its explicit proxy network.
- Kept application capability secrets out of the console render and made Helm rendering examples
  treat generated Secret manifests as sensitive temporary artifacts.

## [0.13.0] - 2026-07-27

### Fixed

- Made embedding-cache entries project-private so cache timing and reuse cannot become a
  cross-tenant oracle.
- Bound cache reads, writes, and invalidation to the same project authority as the knowledge
  operation that requested the embedding.

## [0.12.1] - 2026-07-26

### Fixed

- Required migration and restore checks to match the exact Alembic head rather than accepting any
  stamped revision.
- Completed project-qualified embedding-cache erasure and aligned worker, CLI, and API document
  rejection with the same terminal-state rules.
- Preserved explicit refusal outcomes where a request cannot publish or mutate knowledge.

## [0.12.0] - 2026-07-26

### Fixed

- Added live reverse-proxy traversal for the public route matrix, covering service, MCP, OAuth,
  metrics, console, and console BFF ownership through Caddy.

## [0.11.0] - 2026-07-26

### Fixed

- Contained stored and reflected text at browser, file, parser, and URL sinks, including console XSS
  paths and stored-blob boundaries.
- Narrowed entity erasure so a name match cannot remove unrelated project knowledge.
- Added regression tests for the self-review findings discovered after the first security pass.

## [0.10.1] - 2026-07-26

### Security

- Added Ruff security rules to the required lint gate and tightened production assertions around
  credentials, images, workflows, and rendered deployment output.

## [0.10.0] - 2026-07-26

### Fixed

- Serialized migrations and made application startup wait for the exact schema head.
- Changed the Helm migration resource and pod ordering to avoid install and upgrade deadlocks.
- Added pre-migration tenant-integrity checks for project-qualified references.

## [0.9.0] - 2026-07-26

### Added

- Persistent storage for original source documents alongside relational, graph, and vector state.
- Verifiable snapshot directories containing a database dump, source blobs, sizes, and SHA-256
  digests.

### Fixed

- Made restore fail closed before target mutation when a snapshot is incomplete or altered.
- Extended document, entity, and project erasure across stored blobs and all indexed forms.

## [0.8.0] - 2026-07-25

### Fixed

- Made token budgets, quota admission, and usage ledgers atomic under concurrent requests.
- Serialized per-project knowledge-version allocation and cross-store lifecycle decisions.
- Added transaction boundaries and recovery checks for operations spanning relational and graph
  state.

## [0.7.0] - 2026-07-25

### Fixed

- Converged document review routes on one decision model with terminal rejection semantics.
- Prevented multiple approval or rejection paths from producing conflicting publication state.
- Hardened knowledge-hunting delivery and decision tracking, including explicit undelivered
  outcomes when no channel is configured.

## [0.6.0] - 2026-07-25

### Fixed

- Aligned recall, timelines, feedback, correction, and document reads around authoritative
  claim-level provenance and temporal state.
- Applied knowledge visibility and denial rules before aggregates, ordering, graph expansion, and
  returned context could disclose hidden records.
- Converged submission and correction behavior across MCP, REST, CLI, and stored lifecycle state.

## [0.5.0] - 2026-07-25

P0-C (second half): one edge route map, honoured by every deployment target.

### Fixed

- **Compose/Caddy routes the console at all (R45).** The Caddyfile forwarded *everything* to the API,
  so the `console` service was built, started and unreachable — the product's own UI did not exist on
  its reference deployment. Caddy now owns a path map with two upstreams.
- **Helm stopped swallowing the console's BFF (R48).** `/api` was a single prefix pointing at the
  service, which also captured `/api/auth/*` and `/api/proxy/*` — Next.js route handlers where the
  browser's session lives. Console login therefore worked locally and answered 404 on Kubernetes. The
  service claims `/api/v1`, `/mcp`, `/oauth`, `/.well-known` and `/metrics`; everything else is the
  console.
- **Coolify no longer leaves two owners for one path (R46).** Both the API and the console declared
  `SERVICE_FQDN_… : /`, so which one answered was the proxy's choice rather than the operator's. Each
  now declares the paths it owns.
- **Dokploy publishes the console (R47).** Its Traefik router claimed the whole host for the API, so
  the console was unreachable there too. Both services now have routers, with the service's path
  prefixes at a higher priority and the console holding the root.

### Migrations

None.

## [0.4.0] - 2026-07-25

P0-C (first half) of the audit-remediation program: the production runtime. The gap this batch closes
is the one between "the code works" and "the deployment works".

### Fixed

- **Accepted ingestion is durably queued and worker-run (R37).** The queue and the worker existed and
  nothing used them: uploading a document ran parsing, extraction and embedding on the request thread,
  so no durable record of accepted work existed before the heavy part. A request that died
  mid-processing left a half-ingested document nobody would retry, while the worker container drained
  an empty queue forever. `202` now means the document, its run checkpoint and the queue entry are all
  persisted; the worker resumes from the last checkpoint on redelivery.
- **Readiness performs no model inference (R50).** The container healthcheck runs `brain verify`, and
  verify probed every capability through the gateway — so an outage at a model provider restarted every
  healthy container, and a healthy deployment paid provider tokens on a timer. Readiness now checks
  that capabilities are *configured* and that the local stores answer; the provider probe moved behind
  an explicit `probe_models=True`, which is what AUDIT-044 ratified (deep dependency health is an
  operator diagnostic, never high-frequency readiness).
- **The API and the worker share one runtime (R53).** They assembled separate dependency graphs, and
  the graphs differed: the API's gateway had a usage recorder and an embedding cache, the worker's had
  neither. A document ingested by the worker spent tokens nobody recorded, ignored the daily budget,
  and re-embedded text the API would have reused. Both roles now come from `rsc_brain.runtime.build`,
  so a future divergence has to be declared there rather than appear by omission.
- **Every public surface declares a ceiling (R38).** A 2 MiB JSON body, a 65 KiB free-text field, a
  101-entry array and `limit=100000` were all accepted. Bodies, fields, arrays, pages and windows are
  now bounded in the request schema, so an oversized request is refused by validation before a handler
  allocates anything.

### Added

- `limits` configuration (`PublicLimits`): the ratified ceilings for JSON bodies, ontology documents,
  free text, uploads, public arrays, pages, admin pages, audit-export rows and time windows. A
  deployment may lower them; none may be absent.
- `rsc_brain.runtime.build(role)` — the single composition root for both entry points.

## [0.3.0] - 2026-07-25

P0-B of the audit-remediation program: the hostile-ingress batch. Seven findings, all of them paths
where content someone else supplies reached a parser, a spreadsheet, a log or an agent's instruction
channel.

### Fixed

- **Ontology parsing no longer reaches the network (R07).** `_rdflib_format` fell through to any
  format rdflib supported, JSON-LD included — and rdflib's JSON-LD parser dereferences a remote
  `@context`, so uploading a document made the server contact a host the uploader chose. Formats are
  now an allowlist of the four SPEC-24 ratified names, refused as unsupported rather than as
  malformed, and documents are bounded before parsing (5 MiB, 100,000 statements). A parse failure
  returns a stable error class instead of echoing the submitted content back through the 422.
- **Served document text is explicit untrusted data (R08).** Only recall marked its fragments, so the
  same characters were untrusted when recalled and ordinary when fetched — an agent that fetched
  instead of recalling received a document's embedded instructions as trusted input. `get_document`
  now carries `content_type: "untrusted_data"` plus document/project provenance, and so do the
  console's pending-approval preview and review queue, which show the least vetted text in the
  product.
- **Login resists brute force and enumeration (R09).** Every attempt spent a full argon2id
  verification, so the cost of an attack was ours, not the attacker's; and an unknown email returned
  before the verify while a known one returned after, which discloses account existence no matter how
  identical the response is. There is now a shared per-account and per-source budget in Postgres (not
  per process: replicas would each get their own limit), refusals answer 429 with `Retry-After`, and
  an unknown account pays the same verification against a dummy digest.
- **Audit exports cannot execute in a spreadsheet (R11).** Cells were written raw, so a query text, a
  topic slug or a trace header beginning with `=`, `+`, `-` or `@` was evaluated on open — `=cmd|…`
  executes, `=WEBSERVICE(…)` exfiltrates the row with no click. Active cells are now neutralized with
  the leading apostrophe every spreadsheet reads as text, control characters that could forge records
  are dropped, and the literal value stays recoverable — an audit log must not quietly alter what it
  recorded.
- **A generated first-admin credential never reaches output or logs (R13).** `brain init` printed it
  and put it in the JSON payload, and that command is the migrate-on-boot one-shot, so its stdout is
  the `migrate` service's log — which `deploy/README.md` documented as the way to retrieve it. It is
  now written to `first-admin-credential` in the data volume with mode 0600, and only the path is
  printed, mirroring what the Helm path already did with its Secret.
- **No high advisory remains in the console's production graph (R14).** Every published `next`
  bundles a vulnerable `postcss` and `sharp` — the ranges cover releases up to `16.3.0-preview.7` — so
  no upgrade closes it; the transitive versions are pinned forward with lockfile `overrides`. CI now
  runs `npm audit --omit=dev --audit-level=high`, which it never did, and a gitleaks job whose
  exceptions are exact literals for the deliberate test fixtures rather than a rule or a path glob.
- **Only trusted proxies influence external metadata (R51).** OAuth metadata was built from
  `request.base_url`, so a direct client sending `Host: attacker.example` received an issuer and three
  endpoint URLs on the attacker's host — and a client that discovers metadata that way sends its
  authorization code there. The advertised origin comes from the new `ingress.public_origin` setting;
  request-derived origins are used only when the immediate peer is a configured trusted proxy.

### Added

- `ingress` configuration: `public_origin` (the external scheme+host, a deployment fact) and
  `trusted_proxies` (CIDRs whose forwarding headers may be believed; empty trusts none).

### Migrations

`b8e4f1c7a025` — the shared login-attempt budget.

## [0.2.1] - 2026-07-25

### Fixed

- **The bootstrapped first admin could not administer its own project.** `brain init` wrote its
  default-project membership with `role="admin"` — a value that is not one of the documented project
  roles (`project-admin|member|viewer`). Nothing noticed while the old gate accepted `can_curate` as
  administration; 0.2.0's named-capability matrix does not, so on a fresh install the only human was
  locked out of the management surface (approving documents, reading the audit log, managing sources
  and topics). The membership is now created as `project-admin`. This is the "admin lockout" the
  remediation plan's risk register names as the thing an authorization repair must not cause, so it
  has its own regression test rather than a corrected line.
- **Creating a topic now records its author's authority over it.** Topic authority is explicit for
  every role, the project administrator included, and a fresh install has no topics — so defining one
  used to leave its own author unable to act on anything tagged with it, with a direct database write
  as the only way out. `POST /api/v1/admin/topics` grants the new topic to the caller's membership and
  returns `granted_topics`; the grant is durable, visible and revocable rather than inferred at
  decision time.

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
