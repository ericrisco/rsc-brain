# Start a local rsc-brain API
<!-- diataxis: tutorial -->

By the end of this tutorial, release 0.13.0 serves its OpenAPI schema on
`http://127.0.0.1:8080/openapi.json`, and its readiness check confirms the configured capabilities,
database extensions, and schema revision.

## Before you start

Use a clean release 0.13.0 checkout with no existing rsc-brain database volume. Run every shell
command from the repository root.

You need:

- Python **3.12**;
- uv;
- Docker Engine or Docker Desktop with Compose v2;
- OpenSSL and curl;
- local ports `5432` and `8080` free; and
- network access while uv installs locked dependencies and Docker builds the database image.

The repository does not declare minimum versions for uv, Docker, OpenSSL, or curl. The required
interfaces are the `uv`, `docker compose`, `openssl`, and `curl` commands used below.

## 1. Check the required tools

Run:

```bash
python3.12 --version
uv --version
docker version
docker compose version
openssl version
curl --version
```

Every command must exit with code `0`. The Python output must begin with `Python 3.12`, and the
Compose output must identify Docker Compose v2.

## 2. Install the locked environment

Run:

```bash
uv sync --frozen
export RSC_BRAIN_CONFIG="config.example.yaml"
uv run brain --version
```

The final command prints:

```text
0.13.0
```

The example configuration defines all five required model capabilities. No model request occurs in
this step. Keep this terminal open so the configuration path remains available to later commands.

## 3. Start the data service

Generate a shell-local password and start the development database:

```bash
export POSTGRES_PASSWORD="$(openssl rand -hex 24)"
docker compose up -d --wait db
docker compose exec -u postgres -T db \
  psql -U rsc_brain -d rsc_brain -Atc \
  "SELECT extname FROM pg_extension WHERE extname IN ('age', 'vector') ORDER BY extname;"
```

The extension query prints:

```text
age
vector
```

The first database build compiles pgvector and can take several minutes. Completion time depends
on the host and network.

## 4. Initialize and verify the application state

Keep the same terminal open so `POSTGRES_PASSWORD` remains available. Run:

```bash
export RSC_BRAIN_DATABASE__DSN="postgresql+asyncpg://rsc_brain:${POSTGRES_PASSWORD}@127.0.0.1:5432/rsc_brain"
export RSC_BRAIN_ADMIN_EMAIL="admin@example.test"
export RSC_BRAIN_ADMIN_PASSWORD="$(openssl rand -hex 16)"
uv run brain --json init
uv run brain --json verify
```

On this clean database, `brain init` reports `"migrated": true` and
`"admin": {"email": "admin@example.test", "created": true}`. The verification result is:

```json
{"status": "ok", "checks": [{"name": "capabilities", "ok": true, "detail": "every capability is configured"}, {"name": "database", "ok": true, "detail": "extensions present, schema at head (f3c8e2a91d47)"}]}
```

This result checks configuration completeness, database extensions, and schema readiness. It does
not contact configured model endpoints or prove source-volume writability.

## 5. Start the REST and MCP process

In the same terminal, run:

```bash
uv run uvicorn rsc_brain.api.app:create_app --factory \
  --host 127.0.0.1 --port 8080
```

Keep this process running. Uvicorn reports that it is serving on `http://127.0.0.1:8080`.

## 6. Check the public API schema

Open a second terminal in the repository root and run:

```bash
curl --fail --silent http://127.0.0.1:8080/openapi.json | \
  .venv/bin/python -c 'import json, sys; d=json.load(sys.stdin); print(d["info"]["title"], d["info"]["version"])'
```

The command prints:

```text
rsc-brain 0.13.0
```

## What you started

You now have the PostgreSQL data service and the combined REST/MCP API process. The local path does
not start the Next.js console, the ingestion worker, or a model server. The example configuration
points at local model endpoints, so ingestion and recall require those providers and models to be
running first.

`brain up` and `brain down` are unavailable in release 0.13.0. Docker Compose owns the database
lifecycle for this tutorial.

Continue with [Ingest and query](../how-to/ingest-and-query.md) after configuring a reachable model
provider. Read [Architecture](../explanation/architecture.md) for the distinction between this
source-based path and the full deployment topology.
