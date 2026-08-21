# Contributing to rsc-brain

This guide defines the repository contribution contract. The
[development runbook](docs/AGENTS.md) provides the file map and focused commands; the
[installation runbook](docs/INSTALL.md) is for operators, not contributors.

## Set up the checkout

Prerequisites are Git, Python 3.12, [uv](https://docs.astral.sh/uv/), and Node.js 22 for console
work. Docker is required for integration, edge, and deployment checks.

```bash
uv sync --all-groups
uv run brain --version
uv run pytest

cd apps/admin
npm ci
npm run typecheck
```

The default pytest command excludes tests marked `integration`. Start from a branch based on current
`main`, keep each change focused, and use a pull request for review. The project uses Semantic
Versioning and Conventional Commit prefixes. Sign commits with the Developer Certificate of Origin
when preparing a contribution: `git commit -s`.

## Required checks

Run checks in proportion to the affected surface, then run the full applicable set before handing
off a change:

```bash
uv run ruff check .
uv run ruff format --check src tests
uv run mypy
uv run pytest
uv run python scripts/check_docs.py
uv run python scripts/check_licenses.py
uv run pip-audit
```

For a full data-service gate, build the repository image and run both unit and integration tests:

```bash
export POSTGRES_PASSWORD=local-test-password-change-me
docker compose build db
uv run pytest -m "integration or not integration" \
  --cov=rsc_brain --cov-report=term-missing --cov-fail-under=70
```

Console changes also require:

```bash
cd apps/admin
npm ci
npm run gen:api
npm run lint
npm run typecheck
npm run build
npm audit --omit=dev --audit-level=high
```

Do not report a skipped or unavailable environment check as a pass. The CI workflow is the source of
truth for merge gates; [Security Policy](SECURITY.md) maps the current jobs.

## Rehearse a release without publishing

Before creating a tag, run the `Release` workflow manually from the intended commit:

```bash
gh workflow run release.yml --ref <branch-or-commit>
gh run watch --exit-status
```

Manual invocation is dry-run-only. It calls the same reusable CI workflow used for push and pull
request gates, generates the SBOM, performs the vulnerability scan, and builds the application,
console, and data images with publication disabled. Its reachable jobs have read-only repository
permission: they do not log in to GHCR, push packages, mint provenance, or create/edit a release.

Record the hosted run URL in the release evidence. Local YAML tests prove the workflow graph's
shape, but cannot prove GitHub's resolved token scopes or hosted runner behavior.

## Load-bearing rules

1. Knowledge code receives `ProjectScope`, never an independently supplied project identifier.
2. Authorization is a named capability decision. Topic visibility is applied inside the query that
   produces content, counts, order, pages, graph state, exports, or model context.
3. Permission-denied and absent private objects keep the same external shape where existence would
   disclose information.
4. Callers cannot override capability routing, provider endpoints, or credentials; typed
   configuration owns those choices.
5. Uploaded documents, retrieved text, model output, paths, URLs, and parser formats remain untrusted
   data at their sinks.
6. Multi-step lifecycle and cross-store changes must be idempotent, recoverable, and tested under
   competing decisions or process failure where that can occur.

The stable contracts and RFC process are listed in
[Interface Freeze](docs/interface-freeze.md).

## Tests and evidence

- Write the smallest test that fails on the pre-change behaviour, then observe it pass after the
  implementation. An import, fixture, or syntax failure is not behavioural evidence.
- Use real Postgres + AGE + pgvector for tenant integrity, transactions, graph/vector behaviour,
  migration, backup/restore, or concurrency properties.
- Exercise both allow and deny sides of authorization. A negative assertion also needs a positive
  control proving the protected result was reachable.
- Run `brain eval` before changing a model, provider, embedding, judge, or versioned prompt. The
  [evaluation corpus](evals/README.md) explains the deterministic and live-model boundaries.

## Documentation ownership

Update documentation in the same change when supported behaviour, commands, configuration,
interfaces, deployment, or security controls move:

- `README.md` and `docs/index.md` orient readers.
- `docs/tutorials/`, `docs/how-to/`, `docs/reference/`, and `docs/explanation/` each serve their
  declared mode.
- `CHANGELOG.md` records shipped behaviour, not plans.
- Interface and configuration references must stay covered by `scripts/check_docs.py`.

Public documentation must work from a downloaded checkout and contain no credential values or local
control-plane dependencies.
