# Development runbook (AGENTS.md)

> Dev runbook for humans and coding agents working **inside** the product repo. (This is the
> development guide; the agent-native **installation** runbook is a separate SPEC-16
> deliverable.) Goal: a new contributor is productive in under an hour.

## Get productive in <1 hour

```bash
uv sync --all-groups          # venv + all deps (Python 3.12; uv installs it)
uv run brain --help           # the CLI surface (22 FR-10.1 subcommands)
uv run pytest                 # unit tests (should be green)
uv run ruff check . && uv run mypy   # lint + strict types
```

Optional local data service (Postgres 16 + AGE + pgvector):

```bash
cp .env.example .env          # set a strong POSTGRES_PASSWORD
docker compose up -d --wait db
docker compose exec -u postgres -T db psql -U rsc_brain -d rsc_brain \
  -c "SELECT extname, extversion FROM pg_extension;"
```

## Commands

| Task | Command |
|---|---|
| Install/refresh deps | `uv sync --all-groups` |
| Run a command | `uv run <cmd>` (e.g. `uv run brain doctor --json`) |
| Tests | `uv run pytest` |
| Coverage | `uv run pytest --cov=rsc_brain --cov-report=term-missing` |
| Lint / format | `uv run ruff check .` / `uv run ruff format .` |
| Types | `uv run mypy` |
| SCA / licenses | `uv run pip-audit` / `uv run python scripts/check_licenses.py` |

## Where things live (PRD §11)

```
src/rsc_brain/
  config/     12-factor config (pydantic-settings)           [SPEC-01]
  gateway/    model gateway over LiteLLM (FR-9.*)             [SPEC-01]
  scope.py    ProjectScope — the indivisible auth primitive  [SPEC-01, AUDIT-003]
  stores/     GraphStore / VectorStore / RelationalStore      [frozen SPEC-01 → SPEC-03]
  recall/ ingest/ hunting/(Channel)                           [frozen SPEC-01 → 05/06/15]
  cli/        brain CLI (Typer)                               [skeleton SPEC-01]
  mcp/ api/ knowledge/ skills/ installer/                     [later SPECs]
docker/       AGE+pgvector image + compose guard
docs/         interface-freeze.md, this runbook
```

## What "done" means

See the Definition of Done in [`../CONTRIBUTING.md`](../CONTRIBUTING.md). Short version:
green ruff/mypy/pytest (≥70% cov), clean pip-audit + license audit, tests for new behaviour,
and docs that claim only what is observable in the same change.

## Non-negotiables

- **`ProjectScope` everywhere** — never pass a bare `project_id` into a store/recall/ingest
  call. Cross-project mismatch must fail before any side effect (AUDIT-003).
- **Config owns model routing** — callers pass only a typed `GenerationOptions`; never smuggle
  `model`/`api_base`/`api_key` (AUDIT-005).
- **Frozen interfaces** change only via an approved one-page RFC
  ([`interface-freeze.md`](interface-freeze.md)).
- **12-factor** — config from env overlay, no local state, `brain migrate` is a separate step.
