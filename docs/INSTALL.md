# Phased installer runbook

This page mirrors the current `brain plan` and `brain apply` phase catalog. The catalog is
experimental in release 0.13.0 and is not the recommended clean-install path.

For a working source-based API setup, follow the
[getting-started tutorial](tutorials/getting-started.md). The phased installer currently has three
observable limits:

- its `config` action creates `.env` but does not create `config.yaml` or select
  `config.example.yaml`;
- its `data_service` verification requires the schema at head before the later `migrate` phase; and
- it starts the data and inference containers, not the API, worker, console, or production edge.

On a fresh checkout these constraints can stop `brain apply` before completion. The phase structure,
guardrails, checkpoints, and rollback behavior are tested, but a successful clean-host transcript is
not shipped as release evidence.

## Inspect the flow

```bash
brain doctor --json
brain plan --json
brain apply
brain verify --json
```

`brain plan` is read-only. `brain apply` executes the same ordered catalog, persists verified phase
checkpoints, and attempts rollback only for the phase that failed. `brain verify` checks complete
capability configuration, database extensions, and the exact schema head; it does not contact model
providers or perform an ingest-to-recall round trip.

## Guardrails

1. **Never read the brain's content.** Installer work is limited to host facts, configuration,
   containers, and schema state.
2. **Never hardcode secrets.** Keep database and provider credentials in environment variables,
   secret files, or a secrets backend. Do not commit `.env`.
3. **Human confirmation before `brain apply` and before any catalogued destructive action.** The
   `--yes` flag suppresses prompts and is unsafe outside controlled automation.

The action allow-list contains Compose operations, local configuration writes, and database
migration. Host packages, Docker itself, and GPU drivers are preconditions rather than installer
actions.

## Host preconditions

- Docker Engine or Docker Desktop with Compose v2, with the daemon reachable.
- Ports `8000` and `5432` free according to `brain doctor`.
- For the `workstation` profile, a working GPU runtime for the vLLM Compose profile.
- For `cpu_only`, enough memory and disk for the Ollama backend and configured models.

Resolve every blocker and rerun `brain plan --json` before applying.

## Phase catalog

### Phase `preflight` — Verify host preconditions

- **Precondition:** Docker is reachable and the required ports are free.
- **Verify command:** `brain doctor --json`
- **Success criterion:** Docker is reported available and neither required port is busy.
- **Corrective action:** Start Docker or free the reported port, then rerun `brain plan`.
- **Rollback:** None; this phase is read-only.

### Phase `config` — Prepare configuration

- **Precondition:** A repository-root `.env` with a strong `POSTGRES_PASSWORD` is expected.
- **Verify command:** `test -f .env`
- **Success criterion:** `.env` exists.
- **Corrective action:** Copy `.env.example` to `.env`, set a unique password, and separately select
  a complete application configuration such as `config.example.yaml`.
- **Rollback:** None; review or remove only the local file you created.

### Phase `data_service` — Start the data service

- **Precondition:** Docker is available.
- **Verify command:** `brain verify --json`
- **Success criterion:** The database has AGE and pgvector and is already at the exact schema head.
- **Corrective action:** On a fresh database, run `brain migrate` with the correct DSN before
  resuming; inspect `docker compose logs db` for service failures.
- **Rollback:** `docker compose stop db`; named volumes are preserved.

This verification ordering is a known 0.13.0 installer limitation: migration appears later in the
catalog even though this phase requires migrated state.

### Phase `inference` — Start the local inference backend

- **Precondition:** The data service passes `brain verify`.
- **Verify command:** `docker compose ps`
- **Success criterion:** The selected `ollama` or `vllm` profile container is running.
- **Corrective action:** Use the Ollama profile for `cpu_only`; verify GPU runtime and model resources
  for vLLM.
- **Rollback:** Stop the selected Compose profile; database state remains.

Container state does not prove that all configured models are installed or callable.

### Phase `migrate` — Apply database migrations

- **Precondition:** The data service is running.
- **Verify command:** `brain migrate`
- **Success criterion:** Migration exits successfully and a repeat reports no pending work.
- **Corrective action:** Verify the database DSN and tenant-integrity preflight, then rerun
  `brain migrate`.
- **Rollback:** No automatic downgrade; restore a verified backup into an inactive target when a
  downgrade is required.

### Phase `verify` — Verify the installation

- **Precondition:** The selected data and inference services are running and schema migration
  completed.
- **Verify command:** `brain verify --json`
- **Success criterion:** The result reports `status: "ok"` for capabilities and database.
- **Corrective action:** Resolve each failed check. Then perform a provider probe and an authorized
  ingest-to-recall smoke outside this readiness command.
- **Rollback:** None; this phase is read-only.

## Safer automation use

Capture `brain doctor --json` and `brain plan --json` before invoking `brain apply --yes`. Treat a
green phase report as evidence for the catalogued checks only. It does not mean the API is serving,
the production proxy is configured, or a model-backed knowledge request succeeds.

See [Troubleshooting](how-to/troubleshooting.md) for the supported diagnostic sequence.
