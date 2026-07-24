# Installation runbook (agent-native)

> The **agent-native installation runbook** for rsc-brain (SPEC-16, FR-11.4). A coding agent
> (Claude Code / Codex) — or a human — installs from zero by following this file top to bottom, with
> no intervention beyond the confirmations the guardrails require. This is a **separate document**
> from the development runbook at [`docs/AGENTS.md`](AGENTS.md).
>
> Every success criterion is **mechanical**, evaluated over `--json` output — never interpret prose.
> The phases below mirror `brain plan` exactly; if they ever diverge, the CI runbook lint fails.

## The flow (U9)

```bash
brain doctor --json    # 1. detect host + profile, scan config for secrets, report TLS
brain plan --json      # 2. dry-run: the exact phases apply would run (no side effects)
brain apply            # 3. execute the plan (asks for confirmation first)
brain verify --json    # 4. confirm every check is green
```

`brain apply` is idempotent (re-running a complete install is a no-op), resumes from the last
checkpoint if interrupted, and rolls back the failing phase (never a prior one). Success for the
whole install is **`brain verify --json` reporting `status: "ok"`**.

## Guardrails (non-negotiable)

1. **Never read the brain's content.** Do not open documents, claims, or any installed data. The
   installer touches services, config, and schema only.
2. **Never hardcode secrets.** Secrets come from the environment / Docker secrets only (FR-4.7).
   `.env` holds the `POSTGRES_PASSWORD`; it is gitignored and must never be committed. `brain doctor`
   fails if it finds a populated secret in tracked config.
3. **Human confirmation before `apply` and before any destructive action.** `brain apply` prompts
   before it starts and before any destructive step (volume deletion, `restore`, re-install). The
   `--yes` flag skips prompts and is **UNSAFE — for CI/automation only**.

The installer **never touches the host** (no GPU drivers, no `apt` packages): dependencies run only
as containers (D8). Any unmet host precondition (no Docker, a busy port) is reported by `brain
doctor` / `brain plan` as a **blocker** for you to resolve — the installer will not fix it for you.

## Host preconditions

- **Docker** (Engine + Compose v2) installed and the daemon running.
- Ports **8000** (API) and **5432** (Postgres) free.
- Optional: the **NVIDIA Container Toolkit** for the GPU (`workstation`) profile.

If `brain plan --json` returns `blocked: true`, resolve each listed blocker's `remediation` and
re-run `brain plan`.

## Phases

Each phase lists a precondition, the command that verifies it, the mechanical success criterion, the
corrective action if it fails, and the rollback.

### Phase `preflight` — Verify host preconditions
- **Precondition:** Docker daemon reachable and required ports free.
- **Verify command:** `brain doctor --json`
- **Success criterion:** `host.docker == true` and no required port reported busy.
- **Corrective action:** Install/start Docker; free ports 8000 and 5432; re-run `brain doctor`.
- **Rollback:** None — this phase makes no changes.

### Phase `config` — Prepare configuration
- **Precondition:** A `.env` with a strong `POSTGRES_PASSWORD` is expected at the repo root.
- **Verify command:** `test -f .env`
- **Success criterion:** `.env` exists (then set a strong `POSTGRES_PASSWORD` in it).
- **Corrective action:** `cp -n .env.example .env` and edit `POSTGRES_PASSWORD`.
- **Rollback:** None — writing a local config file is safe and idempotent.

### Phase `data_service` — Start the data service (Postgres 16 + AGE + pgvector)
- **Precondition:** Docker is available.
- **Verify command:** `brain verify --json`
- **Success criterion:** the database is reachable with its extensions and schema at head.
- **Corrective action:** inspect `docker compose logs db`; ensure `POSTGRES_PASSWORD` is set.
- **Rollback:** `docker compose stop db` (the failing phase only; volumes are preserved).

### Phase `inference` — Start the local inference backend
- **Precondition:** the data service is up.
- **Verify command:** `docker compose ps` (the profile's backend container is running).
- **Success criterion:** the `ollama` container (`cpu_only`) or `vllm` container (`workstation`) is up.
- **Corrective action:** on `cpu_only` use `--profile ollama`; `vllm` needs a GPU + the NVIDIA toolkit.
- **Rollback:** `docker compose --profile <backend> stop`.

### Phase `migrate` — Apply database migrations
- **Precondition:** the data service is up.
- **Verify command:** `brain migrate` (idempotent — a no-op on a migrated database).
- **Success criterion:** the schema is at head (migrate reports nothing to apply).
- **Corrective action:** ensure the database is reachable, then re-run `brain migrate`.
- **Rollback:** None automatic — a schema downgrade is destructive and requires explicit confirmation.

### Phase `verify` — Verify the installation
- **Precondition:** services started and migrated.
- **Verify command:** `brain verify --json`
- **Success criterion:** `status: "ok"` — every check green.
- **Corrective action:** read the failing check's `detail` and address that service/phase.
- **Rollback:** None — this is the terminal success gate.

## Known errors → fix

| Symptom (`--json`) | Fix |
|---|---|
| `plan.blocked == true`, blocker `docker` | Install Docker and start the daemon (host precondition, D8). |
| `plan.blocked == true`, blocker `port-5432` / `port-8000` | Stop whatever holds the port, then re-run `brain plan`. |
| `doctor.status == "secrets_found"` | Remove the hardcoded secret from tracked config; use `.env` / Docker secrets. |
| `verify` check `database` FAIL | `docker compose up -d --wait db`; confirm `POSTGRES_PASSWORD`. |
| `verify` check `gateway` FAIL | Start the inference backend (`docker compose --profile ollama up -d`). |

## Agent-native install test (E8.3)

To reproduce the gate evidence on a clean VM (per release, both profiles):

1. Provision a clean VM meeting only the host preconditions above (Docker; for `workstation`, a GPU
   + the NVIDIA Container Toolkit). No other setup.
2. Give a Claude Code agent **this file as its only instruction** and let it run the U9 flow,
   pausing only for the guardrail confirmations.
3. The install passes when `brain verify --json` returns `status: "ok"` with no manual step beyond
   those confirmations. Record the transcript + wall-clock time (target: < 30 min, G1).
4. Repeat on the `cpu_only` profile (no GPU) to cover G5.

> This end-to-end run needs a clean VM + a live agent + model backends, so it is a **documented
> per-release manual gate**, not a CI job (SPEC-16 §7). The deterministic phase logic — idempotence,
> per-phase rollback, checkpoint resume, the D8 action allow-list, and this runbook's structure — is
> covered automatically by the installer test suite.
