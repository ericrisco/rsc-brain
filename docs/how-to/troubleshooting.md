# Troubleshoot rsc-brain
<!-- diataxis: how-to -->

Start with structured diagnostics and follow the failing boundary. Avoid pasting tokens, passwords,
document contents, or full environment files into issue reports.

## Collect a safe baseline

```bash
uv run brain --version
uv run brain doctor --json
uv run brain verify --json
```

`brain doctor` checks host facts, recommends a hardware profile, reports TLS configuration, and
scans tracked configuration candidates for likely secrets. `brain verify` checks capability
configuration and database readiness. Neither command proves a live provider call or a complete
ingest-to-recall path.

## Installation plan is blocked

Run:

```bash
uv run brain plan --json
```

Resolve each blocker's `remediation`, then rerun the plan. Common causes are an unavailable Docker
daemon or occupied ports. Review the plan before running `brain apply`; `--yes` suppresses human
confirmation and is intended for controlled automation.

## Database check fails

For the development database:

```bash
docker compose ps db
docker compose logs db
docker compose exec -u postgres -T db \
  psql -U rsc_brain -d rsc_brain -Atc \
  "SELECT extname FROM pg_extension WHERE extname IN ('age', 'vector') ORDER BY extname;"
uv run brain migrate
uv run brain verify --json
```

The extension query must return `age` and `vector`. Verify that the application DSN points to this
database and that its schema is at the exact migration head.

## Capabilities check fails

All five routes are required: `extractor`, `judge`, `topicalizer`, `embedder`, and `reranker`.
Each needs a provider and model. The embedder must return 1024-dimensional vectors.

Compare the effective environment with the [configuration reference](../reference/configuration.md).
The shipped production Compose and Helm defaults expose only embedder settings, so add the other
four routes through a private environment override or Helm `extraEnv`. Also provide a reachable
model endpoint; the production Compose file does not start one.

## API is ready but ingestion fails

Readiness does not call providers. Check the ingestion run rather than the upload response:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${BRAIN_PAT}" \
  "${BRAIN_URL}/api/v1/ingest/runs"
```

Check provider reachability from the API and worker network namespaces, not only from the host.
Confirm the expected model exists at each configured route. PDF parsing additionally needs the
operator-installed Docling backend; Markdown ingestion is available in the locked default
environment.

## Upload fails with a permission error

The packaged storage definitions do not initialize volume ownership. The Compose application runs
as UID `10001`; Helm sets pod UID `1000`. Provision `app_data` and the reserved inbox for that UID by
using the storage backend's ownership mechanism, then test writes from both running processes. The
deployment guide contains the exact smoke commands.

Compose/Helm structure checks, rendered-manifest validation, readiness, and a bound PVC do not prove
that a non-root process can create a source blob. Treat a failed live write as a storage-provisioning
failure rather than a model or queue failure.

The inbox mount is not a fallback transport. No packaged 0.13.0 process starts the folder watcher,
so copying a file there does not produce an ingestion run. Use the authenticated REST upload.

## MCP reports `AUTH_INVALID`

Confirm that the client sends `Authorization: Bearer ck_…` to the `/mcp` endpoint. The same error
covers absent, malformed, expired, revoked, and disabled-principal credentials. Create a new PAT
from the console when the original value is unavailable.

If the tool list loads but recall is empty, check topic grants, document publication status, the
relevance threshold, and whether the query asks for current or historical knowledge. Hidden and
absent data intentionally share an empty shape.

## MCP returns HTTP `421`

The proxy's `Host` header does not match the MCP DNS-rebinding allow-list. Set
`RSC_BRAIN_INGRESS__PUBLIC_ORIGIN` to the exact external origin, for example
`https://brain.example.com`, and pass it into the API container. Default ports `80` and `443` are
normalized; a nonstandard port must appear in both the configured origin and the request. If an
`Origin` header comes from a different origin, the request is rejected with HTTP `403`.

The configured value must contain only an HTTP(S) scheme and ASCII host. Use the domain's IDNA
punycode form when its display name contains Unicode; do not add a path or credentials.

Keep DNS-rebinding protection enabled. Correct the origin and proxy headers instead of admitting a
wildcard host or origin.

## Reverse proxy routing is wrong

The service owns `/api/v1`, `/mcp`, `/oauth`, `/.well-known`, and `/metrics`. The console owns `/`
and its `/api/auth` and `/api/proxy` routes. Preserve bearer headers and streamable HTTP responses
through the proxy. Set `RSC_BRAIN_INGRESS__PUBLIC_ORIGIN` to the external HTTPS origin; otherwise
OAuth metadata falls back to `https://localhost`, hunt links to `https://brain.local`, and MCP
accepts loopback hosts and origins only.

The API also serves `/hunt/{token}`, but the packaged 0.13.0 proxies omit that route and send it to
the console. Public hunt replies are unavailable on those deployment targets until their route maps
are corrected. Use the deployment details in [Deploy rsc-brain](../../deploy/README.md).

## `brain up` or `brain down` exits with code 2

These CLI commands are declared but unavailable in release 0.13.0. Use Docker Compose, Helm, or
your process supervisor for service lifecycle management.

## `/metrics` returns a denial or the console page does not open

This is the packaged 0.13.0 route collision. The edge sends `/metrics` to the Python Prometheus
endpoint, and no current principal type receives `operator.metrics.read`, so that endpoint returns
an authentication or authorization denial. The same route assignment prevents the Next.js
product-metrics page from receiving the request.

There is no packaged public route for either surface in this release. Use the scoped administration
observability APIs for authorized project data. The console page can be inspected through a direct
console development origin, where `/metrics` is not intercepted by the packaged edge.

For stable command and error lookup, see the [CLI reference](../reference/cli.md),
[REST API reference](../reference/rest-api.md), and [MCP reference](../reference/mcp.md).
