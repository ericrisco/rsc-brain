# Coding-agent guidance

Read the [development runbook](AGENTS.md) before changing this repository and use the
[contributing guide](../CONTRIBUTING.md) as the definition of done.

Four rules carry the highest implementation risk:

1. Pass `ProjectScope` into knowledge, storage, recall, and ingestion boundaries; never combine a
   principal with a separate caller-selected project.
2. Keep model provider, model, endpoint, fallback, and credentials under typed configuration.
3. Change contracts listed in [Interface Freeze](interface-freeze.md) only through an approved RFC
   and matching contract tests.
4. Keep public documentation synchronized with executable behavior and run
   `uv run python scripts/check_docs.py`.

Use failing behavioral tests before implementation, include allow and deny cases for authorization,
and use the real data-service suite for tenant, transaction, graph, vector, migration, concurrency,
backup, or restore claims.
