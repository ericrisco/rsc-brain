# Contributing to rsc-brain

Thanks for helping build rsc-brain. This guide gets a new contributor (human or coding agent)
productive quickly. The deeper development runbook lives in [`docs/AGENTS.md`](docs/AGENTS.md).

## Development setup

```bash
uv sync --all-groups        # venv + all deps (Python 3.12)
uv run pytest               # tests
uv run ruff check .         # lint
uv run ruff format .        # format
uv run mypy                 # strict types
uv run pre-commit install   # optional: run the hooks on commit
```

## Definition of done (what CI enforces)

- `ruff check` and `ruff format --check` clean.
- `mypy --strict` clean.
- `pytest` green with **≥70%** coverage.
- `pip-audit` reports no known vulnerabilities; the AGPL license audit passes.
- New behaviour has tests; docs/CHANGELOG claim only what is observable in the same change
  (no premature "done").

## Commits & branches

- Work on a branch off `main`; open a Pull Request. Direct pushes to `main` are not allowed.
- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`,
  `docs:`, `ci:`, …). The project follows [SemVer](https://semver.org/).
- **Sign off** every commit (Developer Certificate of Origin): `git commit -s`.

## Hard rules (automatic PR rejection)

These are non-negotiable and are gated in review/CI:

1. A knowledge query without a `ProjectScope` (a bare `project_id`) — see
   [`docs/interface-freeze.md`](docs/interface-freeze.md) (AUDIT-003).
2. A permission/tag filter applied **outside** the store query instead of in it (FR-4.2).
3. "Denied" being distinguishable from "does not exist" on any permission-checked path (FR-4.3).
4. Ingestion writing malformed/unvalidated data to the graph instead of discarding-and-logging
   (FR-1.8).

## Frozen interfaces

`GraphStore`, `VectorStore`, `RelationalStore`, `Channel`, and the `recall`/`ingest` signatures
are **frozen** (see [`docs/interface-freeze.md`](docs/interface-freeze.md)). Changing them
requires a one-page RFC approved before the change.

## Models, prompts & evals

Run `brain eval` before changing any model, provider, or versioned prompt (the eval harness
lands in SPEC-06). Never change a capability's model/routing from call data — it is owned by
configuration (AUDIT-005).
