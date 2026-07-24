# rsc-brain

**Self-hosted, open-source (AGPL-3.0) company memory.** rsc-brain ingests a company's
documents into a **living knowledge graph** with per-fact credibility and temporal validity,
and exposes it over **MCP** to Claude/ChatGPT under deterministic, topic-based permissions.
When knowledge is missing or contradictory it **asks the responsible human** instead of
hallucinating. Runs 100% local (Ollama/vLLM) or against any cloud provider, configurable per
capability layer.

> **Status: Sprint 0 (bootstrap), in progress.** This section is kept honest — it lists only
> what is in the tree and works today. Building the foundations from **SPEC-01**:
>
> - ✅ Project skeleton (PRD §11), packaged with **uv** (Python 3.12); `ruff`, `mypy --strict`,
>   `pytest`, `pre-commit`.
> - ✅ Tracked publication boundary inherited by every worktree.
> - ✅ **12-factor configuration** (`rsc_brain.config`): YAML + environment overlay.
> - ✅ **Frozen interfaces** (`GraphStore`, `VectorStore`, `RelationalStore`, `Channel`,
>   `recall`/`ingest` signatures) with an indivisible `ProjectScope` (see
>   [`docs/interface-freeze.md`](docs/interface-freeze.md)).
> - ✅ **`brain` CLI** skeleton (all FR-10.1 subcommands, global `--json`).
> - ⏳ Next in this bootstrap: the **model gateway** (LiteLLM), the **data-service Compose**
>   stack (Postgres 16 + AGE + pgvector), and **CI**.
>
> Product capabilities (ingestion, recall, MCP serving, console, …) land in later SPECs; the
> CLI subcommands for them exit non-zero with a `not_implemented` payload until then.

## Requirements

- **Python 3.12** and **[uv](https://docs.astral.sh/uv/)**.

## Quickstart (works today)

```bash
uv sync                     # create the venv and install deps (incl. dev tools)
uv run brain --help         # list the CLI surface (all 22 subcommands)
uv run brain --version
uv run ruff check .         # lint
uv run ruff format --check .
uv run mypy                 # strict type check
uv run pytest               # unit tests
```

Unimplemented CLI subcommands exit non-zero with a structured payload:

```bash
uv run brain doctor --json  # -> {"status": "not_implemented", "command": "doctor"} ; exit 2
```

## Configuration (12-factor)

Configuration is a YAML file overlaid by environment variables (env wins). Copy
[`config.example.yaml`](config.example.yaml) and override secrets **only** via env / Docker
secrets — never commit real keys (`RSC_BRAIN_<SECTION>__<KEY>` sets nested values).

## License

[AGPL-3.0-or-later](LICENSE).
