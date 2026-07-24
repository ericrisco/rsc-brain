<!-- Thanks for contributing to rsc-brain. Keep this checklist honest. -->

## What & why

<!-- What does this change do, and which SPEC / requirement does it serve? -->

## Checklist

- [ ] `uv run ruff check .` and `uv run ruff format --check src tests` clean
- [ ] `uv run mypy` clean (strict)
- [ ] `uv run pytest` green with **≥70%** coverage; new behaviour has tests
- [ ] `uv run pip-audit` and `uv run python scripts/check_licenses.py` pass
- [ ] Docs / CHANGELOG claim only what is observable in this change (no premature "done")
- [ ] No bare `project_id` reaches a store/recall/ingest call (`ProjectScope` only, AUDIT-003)
- [ ] Model routing is not driven by call data (AUDIT-005)
- [ ] If a frozen interface changed, a one-page RFC is linked and approved
- [ ] Commits are signed off (`git commit -s`, DCO)
