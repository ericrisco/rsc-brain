# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> "Added" entries describe capabilities whose behaviour is observable and verifiable **in the
> same commit** (per AUDIT-002). Planned-but-unbuilt work is not listed as added.

## [Unreleased]

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

[Unreleased]: https://github.com/ericrisco/rsc-brain/commits/main
