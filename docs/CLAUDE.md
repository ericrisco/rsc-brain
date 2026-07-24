# CLAUDE.md — development guidance

> Guidance for Claude (and other coding agents) working inside the rsc-brain product repo.
> The full development runbook is [`AGENTS.md`](AGENTS.md) — read it first.

## Fast path

```bash
uv sync --all-groups
uv run pytest            # green?
uv run ruff check . && uv run mypy
```

## The four rules you must not break

1. **`ProjectScope`, never a bare `project_id`** into store/recall/ingest calls; cross-project
   mismatch fails before any side effect (AUDIT-003).
2. **Config owns model routing** — pass only a typed `GenerationOptions`; never `model`/
   `api_base`/`api_key` from call data (AUDIT-005).
3. **Frozen interfaces** (`docs/interface-freeze.md`) change only via an approved RFC.
4. **Truthful docs** — a CHANGELOG/README claim must be observable and verified in the same
   change; label work-in-progress as such.

## Definition of done

Green `ruff` + `mypy --strict` + `pytest` (≥70% cov), clean `pip-audit` and license audit,
tests for new behaviour. See [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
