# Phased installer runbook

This page mirrors the current `brain plan` and `brain apply` phase catalog.

`brain apply` takes a clean host from nothing to a migrated data service and a running inference
backend, in one command, with no file to hand-edit first. It generates the database password itself.

Two limits remain, and they are scope, not defects:

- its `config` action creates `.env` and its secrets, but does not create `config.yaml` — select
  `config.example.yaml` and set your model routes before the terminal `verify` can pass; and
- it starts the data and inference containers, not the API, worker, console, or production edge.
  **For a full production deployment — API, worker, console and an HTTPS edge — follow
  [deploy/README.md](../deploy/README.md) instead**; that is the path a company installs.

Two earlier limits were removed on 2026-08-13 after a clean-host install run stopped on both:

- the `config` phase copied a template and reported success while leaving `POSTGRES_PASSWORD`
  empty, which the next phase refuses (it now generates the secret, and verifies it is usable); and
- every phase up to and including `migrate` gated on `brain verify`, which demands the schema **at
  head** — the schema that `migrate` is what creates. A fresh database could therefore never reach
  the phase that would have migrated it. `migrate` now runs directly after the data service, and the
  full `brain verify` is the terminal gate only.

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

- **Precondition:** `.env.example` exists to materialise from.
- **Verify command:** `brain init-env --check`
- **Success criterion:** every required secret is set — neither blank nor a placeholder.
- **Corrective action:** run `brain init-env`. It creates `.env` if absent and generates any unset
  required secret. It is idempotent: a value already set is never rotated, so re-running `apply` on
  a live install cannot change the password out from under a running database.
- **Rollback:** None; review or remove only the local file you created.

### Phase `data_service` — Start the data service

- **Precondition:** Docker is available.
- **Verify command:** `docker compose exec -T db pg_isready -q`
- **Success criterion:** the `db` container is up and accepting connections. (`docker compose ps`
  is not used: it exits 0 even when the service does not exist.)
- **Corrective action:** inspect `docker compose logs db` for service failures.
- **Rollback:** `docker compose stop db`; named volumes are preserved.

This phase deliberately does **not** assert schema state: the schema is created by `migrate`, which
runs next.

### Phase `migrate` — Apply database migrations

- **Precondition:** the `db` container is accepting connections.
- **Verify command:** `brain wait-for-schema --timeout 0`
- **Success criterion:** the schema is at head. The check observes; it does not migrate.
- **Corrective action:** Verify the database DSN and tenant-integrity preflight, then rerun
  `brain migrate`.
- **Rollback:** No automatic downgrade; restore a verified backup into an inactive target when a
  downgrade is required.

### Phase `inference` — Start the local inference backend

- **Precondition:** the `db` container is running.
- **Verify command:** `docker compose ps`
- **Success criterion:** The selected `ollama` or `vllm` profile container is running.
- **Corrective action:** Use the Ollama profile for `cpu_only`; verify GPU runtime and model resources
  for vLLM.
- **Rollback:** Stop the selected Compose profile; database state remains.

Container state does not prove that all configured models are installed or callable.

### Phase `verify` — Verify the installation

- **Precondition:** The selected data and inference services are running and schema migration
  completed.
- **Verify command:** `brain verify --json`
- **Success criterion:** The result reports `status: "ok"` for capabilities and database.
- **Corrective action:** Resolve each failed check. Then perform a provider probe and an authorized
  ingest-to-recall smoke outside this readiness command.
- **Rollback:** None; this phase is read-only.

## After the install: calibrate the abstention threshold

The phase catalog above ends at a running, migrated, reachable stack. It does **not** leave you with
a system that reliably says "I don't have that".

Recall abstains when the best fragment's blended score falls below τ (SPEC-06 FR-3.3). The shipped
default is `0.45`, and the score is `0.55·similarity + 0.25·credibility + 0.10·freshness +
0.10·importance` — so the terms that have nothing to do with your question already supply most of the
threshold. Measured on a real install: credible, fresh knowledge contributed `0.324` of the `0.45`,
leaving an effective similarity floor of `0.230`, while pure gibberish scored `0.304` similarity
against the ingested corpus. Un-calibrated, the gate separates sense from nonsense by hundredths on a
quantity whose noise is tenths.

τ is therefore **per-install**, not a constant:

```bash
brain eval --golden /path/to/your-golden.yaml        # what your set contains
brain calibrate --golden /path/to/your-golden.yaml   # the set + the current default
```

The calibration set is a YAML file with a `cases` list, each case carrying the question, the family,
and whether the answer must be found or must be abstained from. **No default set is shipped on
purpose**: this repository's golden set describes two fictional companies, and calibrating against it
would give you a confidently wrong threshold for your own knowledge. Install your own at
`/etc/rsc-brain/golden.yaml` or pass `--golden` each time.

Until you have done this, treat every `found: true` as unverified: the system will answer questions
whose subject it has never seen, from knowledge that is credible but irrelevant.

## Safer automation use

Capture `brain doctor --json` and `brain plan --json` before invoking `brain apply --yes`. Treat a
green phase report as evidence for the catalogued checks only. It does not mean the API is serving,
the production proxy is configured, a model-backed knowledge request succeeds, or that abstention has
been calibrated.

See [Troubleshooting](how-to/troubleshooting.md) for the supported diagnostic sequence.
