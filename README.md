# rsc-brain

rsc-brain is a self-hosted company-memory service. It turns approved documents into
permission-filtered knowledge fragments with provenance, credibility, and temporal state, then
exposes them through MCP, a REST API, a command-line interface, and an administration console.

Release **0.14.0** is **alpha software**. The project is pre-1.0, and interfaces, configuration, and
deployment behavior can change between releases.

## What runs in this release

- A Python API process serves REST and streamable HTTP MCP on one port.
- A PostgreSQL 16 data service combines relational state, pgvector search, and Apache AGE graphs.
- A PostgreSQL-backed worker queue moves document processing off the HTTP request path.
- Project and topic scope is derived from the caller's credential and applied inside storage
  queries.
- Markdown ingestion is included. PDF and OCR ingestion requires the operator-installed Docling
  backend, which is not part of the locked default environment.

## Prerequisites

The supported source-based local path requires:

- Python **3.12** and [uv](https://docs.astral.sh/uv/);
- Docker Engine or Docker Desktop with the Compose v2 `docker compose` command;
- OpenSSL and curl;
- free local ports `5432` for PostgreSQL and `8080` for the API; and
- network access for the first dependency and container-image download.

## Start the local API

Run these commands from a clean release 0.14.0 checkout:

```bash
uv sync --frozen
export RSC_BRAIN_CONFIG="config.example.yaml"
export POSTGRES_PASSWORD="$(openssl rand -hex 24)"
docker compose up -d --wait db
export RSC_BRAIN_DATABASE__DSN="postgresql+asyncpg://rsc_brain:${POSTGRES_PASSWORD}@127.0.0.1:5432/rsc_brain"
export RSC_BRAIN_ADMIN_EMAIL="admin@example.test"
export RSC_BRAIN_ADMIN_PASSWORD="$(openssl rand -hex 16)"
uv run brain --json init
uv run brain --json verify
uv run uvicorn rsc_brain.api.app:create_app --factory --host 127.0.0.1 --port 8080
```

Keep the last command running. From another terminal, check the public schema:

```bash
curl --fail --silent http://127.0.0.1:8080/openapi.json | \
  .venv/bin/python -c 'import json, sys; d=json.load(sys.stdin); print(d["info"]["title"], d["info"]["version"])'
```

Success is `rsc-brain 0.14.0`. The `brain verify` result must also report `"status": "ok"` with
passing `capabilities` and `database` checks. The complete, check-by-check path is in
[Start a local rsc-brain API](docs/tutorials/getting-started.md).

## Current boundaries

- `brain up` and `brain down` are unavailable. Both commands return a `not_implemented` result and
  exit with code `2`; Docker Compose owns the service lifecycle.
- Readiness checks capability configuration and the local database. It does not call model
  providers or prove an ingest-to-recall round trip.
- The repository's production Compose topology does not provision a model server and does not
  inject every required capability setting. Supply complete capability configuration and a
  reachable provider before using ingestion or recall in that topology.
- The packaged reverse proxies do not route the public `/hunt/{token}` reply page in 0.14.0.
  Configured SMTP or Slack hunts can send a link that reaches the console instead of the API; treat
  public hunt replies as unavailable on those targets.
- Packaged edges route `/metrics` to the protected Prometheus endpoint. No 0.14.0 principal can
  satisfy its operator capability, and this route also intercepts the console's product-metrics page
  at the same path. Both public surfaces are unavailable on the packaged targets.
- REST upload does not currently enforce the declared `limits.upload_bytes` value. Apply a request-
  body ceiling at the trusted edge before exposing document upload.
- The source-based path above starts the REST and MCP service, not the Next.js console or the
  ingestion worker.
- REST upload is the operative document transport. The repository contains watcher code and the
  packaged layouts reserve an inbox volume, but no deployed process starts that watcher in 0.14.0;
  dropping a file into the inbox does not enqueue it. Third-party connector integrations are also
  unavailable.
- The packaged application volumes have no ownership initializer. Compose runs the application as
  UID `10001`, while Helm overrides it with UID `1000`; an operator must provision writable volume
  ownership and prove a live write before ingestion.

## Documentation

- [Documentation map](docs/index.md)
- [Getting started tutorial](docs/tutorials/getting-started.md)
- [Architecture](docs/explanation/architecture.md)
- [Knowledge lifecycle](docs/explanation/knowledge-lifecycle.md)
- [Security and tenancy](docs/explanation/security-and-tenancy.md)
- [Deployment topology](deploy/README.md)
- [CLI reference](docs/reference/cli.md)
- [Configuration reference](docs/reference/configuration.md)
- [Recorded release notes](CHANGELOG.md)

For changes to the project, see [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities through
the private channel in [SECURITY.md](SECURITY.md).

## License

[AGPL-3.0-or-later](LICENSE)
