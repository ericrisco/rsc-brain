# Deploy rsc-brain

The repository ships one production Compose topology, two routing overlays, and a Helm chart. They
package the API, worker, console, PostgreSQL 16 with AGE and pgvector, persistent source storage,
migration ordering, and an HTTPS edge.

Release 0.13.0 is alpha. The deployment definitions are tested for structure, route ownership,
migration ordering, and rendered Kubernetes validity. They are not a zero-configuration model
stack: operators must supply all model routes and a reachable provider.

## What each target provides

| Target | Provides | Operator still provides |
|---|---|---|
| Production Compose | Database, migration job, API, worker, console, Caddy, named volumes | Domain/DNS, complete model configuration, reachable model provider, explicit first-admin password, writable volume ownership |
| Coolify overlay | Compose topology with Coolify TLS/path ownership and generated `SERVICE_PASSWORD_POSTGRES` | Matching `POSTGRES_PASSWORD`, explicit admin password, domain/public origin, complete model configuration, provider, writable volume ownership |
| Dokploy overlay | Compose topology with Traefik TLS/path ownership | Database/admin passwords, domain/public origin, complete model configuration, provider, writable volume ownership |
| Helm chart | PostgreSQL StatefulSet, migration Job, API/worker/console Deployments, fixed-RWO PVCs, Ingress | Storage ownership and compatible scheduling, ingress infrastructure, TLS issuer, complete model configuration, images, provider |

GPU drivers, the NVIDIA runtime/device plugin, DNS, ingress controllers, cert-manager, and external
model services remain host or cluster preconditions.

## Required application configuration

`AppConfig` requires `extractor`, `judge`, `topicalizer`, `embedder`, and `reranker` capability
objects. Every object needs a provider and model. A provider endpoint and API key may also be
required. The embedder must return 1024-dimensional vectors.

The canonical Compose and chart values expose embedder fields only. Add the other four capabilities
through an environment overlay or Helm `extraEnv`; setting variables in the host environment alone
does not inject undeclared Compose variables into a container.

The production Compose file does not start Ollama or vLLM. An endpoint such as
`http://ollama:11434` works only when that hostname exists on the deployment network and serves the
configured models.

See the [configuration reference](../docs/reference/configuration.md) for every field.

## Raw Docker Compose

Create the secret file and edit the domain and admin email before deployment. Add the public HTTPS
origin as `RSC_BRAIN_INGRESS__PUBLIC_ORIGIN` in the protected environment; it drives OAuth
metadata, hunt links, and the MCP Host and Origin allow-list, and is distinct from the hostname-only
`RSC_BRAIN_DOMAIN`:

```bash
./deploy/init-secrets.sh
chmod 600 deploy/.env
```

The script writes unique database and first-admin passwords to `deploy/.env`; neither password is
printed. Set `RSC_BRAIN_DOMAIN` to the public hostname and add
`RSC_BRAIN_INGRESS__PUBLIC_ORIGIN=https://<that-hostname>`. Keep the explicit
`RSC_BRAIN_ADMIN_PASSWORD`. In the current Compose topology the one-shot `migrate` container does
not mount `app_data`, so an omitted password would be written to an ephemeral container and would
not be recoverable through the API container.

Create an untracked environment overlay that injects all model routes into both API and worker. This
example assumes an Ollama-compatible service named `model-host` on the Compose network:

```yaml
# deploy/compose.models.yml — keep provider secrets out of version control
services:
  api: &model-routes
    environment:
      RSC_BRAIN_CAPABILITIES__EXTRACTOR__PROVIDER: ollama
      RSC_BRAIN_CAPABILITIES__EXTRACTOR__MODEL: qwen2.5:14b-instruct
      RSC_BRAIN_CAPABILITIES__EXTRACTOR__API_BASE: http://model-host:11434
      RSC_BRAIN_CAPABILITIES__JUDGE__PROVIDER: ollama
      RSC_BRAIN_CAPABILITIES__JUDGE__MODEL: qwen2.5:14b-instruct
      RSC_BRAIN_CAPABILITIES__JUDGE__API_BASE: http://model-host:11434
      RSC_BRAIN_CAPABILITIES__TOPICALIZER__PROVIDER: ollama
      RSC_BRAIN_CAPABILITIES__TOPICALIZER__MODEL: llama3.1:8b-instruct
      RSC_BRAIN_CAPABILITIES__TOPICALIZER__API_BASE: http://model-host:11434
      RSC_BRAIN_CAPABILITIES__EMBEDDER__PROVIDER: ollama
      RSC_BRAIN_CAPABILITIES__EMBEDDER__MODEL: bge-m3
      RSC_BRAIN_CAPABILITIES__EMBEDDER__API_BASE: http://model-host:11434
      RSC_BRAIN_CAPABILITIES__RERANKER__PROVIDER: ollama
      RSC_BRAIN_CAPABILITIES__RERANKER__MODEL: bge-reranker-v2-m3
      RSC_BRAIN_CAPABILITIES__RERANKER__API_BASE: http://model-host:11434
      RSC_BRAIN_INGRESS__PUBLIC_ORIGIN: ${RSC_BRAIN_INGRESS__PUBLIC_ORIGIN:?public HTTPS origin required}
  worker: *model-routes
```

Adjust provider and model names to the service you operate. If it needs credentials, map each API
key from a protected environment or secret source rather than writing the value into this overlay.

### Provision application-volume ownership

The image runs as UID `10001`, but the Compose definitions do not initialize ownership on fresh
`app_data` or `inbox` volumes. Provision both mounts before starting the application. For new empty
Docker-managed volumes, first build the shared application image through the `migrate` service. The
API service references that same image and mounts both paths, so a one-time root task can assign
them before any long-running process starts:

```bash
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml \
  -f deploy/compose.models.yml \
  build migrate
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml \
  -f deploy/compose.models.yml \
  run --rm --no-deps --user 0 api \
  sh -ceu 'chown -R 10001:10001 /var/lib/rsc-brain/data'
```

For an existing volume or a platform-managed storage driver, use that backend's ownership procedure
and preserve existing data. Coolify and Dokploy operators need an equivalent one-time task.

Start the topology:

```bash
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml \
  -f deploy/compose.models.yml \
  up -d --build
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml \
  -f deploy/compose.models.yml \
  ps
```

The `migrate` service runs `brain init` once. API and worker wait for successful completion. Caddy
serves the console at `https://<domain>/`, REST below `/api/v1`, and MCP at
`https://<domain>/mcp`.

Verify local readiness inside the API image:

```bash
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml \
  -f deploy/compose.models.yml \
  exec api brain verify --json
```

This checks configuration and database state without calling model providers. Follow it with a
provider check and an authorized ingest-to-recall smoke. First prove both application processes can
write the shared source volume:

```bash
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml \
  -f deploy/compose.models.yml \
  exec api sh -ceu 'p=/var/lib/rsc-brain/data/.write-probe; : > "$p"; rm "$p"'
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml \
  -f deploy/compose.models.yml \
  exec worker sh -ceu 'p=/var/lib/rsc-brain/data/.write-probe; : > "$p"; rm "$p"'
```

## Coolify and Dokploy

Apply the canonical file and one overlay together:

```bash
docker compose \
  -f deploy/docker-compose.prod.yml \
  -f deploy/docker-compose.coolify.yml \
  -f deploy/compose.models.yml \
  config
```

Replace `docker-compose.coolify.yml` with `docker-compose.dokploy.yml` for Dokploy. The overlays
change edge routing and platform-provided secrets; they do not fill the four missing capability
objects or run a model provider.

The Coolify overlay uses explicit Traefik labels in Raw Compose mode so API and console share the
single hostname in `RSC_BRAIN_DOMAIN`. Do not replace them with separate `SERVICE_FQDN_*`
identifiers: Coolify generates a different wildcard origin for each identifier. Do not declare a
custom Coolify network either; Coolify attaches its proxy to the deployment network it manages.
Router and service object names include `COMPOSE_PROJECT_NAME`, so independent Compose projects do
not overwrite each other's Traefik configuration.

Dokploy's Traefik can discover only containers attached to its external `dokploy-network`. The
overlay attaches API and console to that network and also retains `default`, which carries their
internal `api`, `db`, and migration traffic. The external network must already exist; a normal
Dokploy installation creates it.

Compose interpolates the canonical file before it merges an overlay. The Coolify overlay's
`SERVICE_PASSWORD_POSTGRES` mapping therefore cannot satisfy the canonical
`${POSTGRES_PASSWORD:?...}` expression or the application DSN by itself. Set these deployment
variables before Coolify or Dokploy parses the files:

| Target | Required deployment variables |
|---|---|
| Coolify | Let Coolify generate `SERVICE_PASSWORD_POSTGRES`; set `POSTGRES_PASSWORD` to exactly the same value. Set an explicit `RSC_BRAIN_ADMIN_PASSWORD`, hostname-only `RSC_BRAIN_DOMAIN`, and `RSC_BRAIN_INGRESS__PUBLIC_ORIGIN=https://<same-hostname>`. |
| Dokploy | Set a strong `POSTGRES_PASSWORD`, explicit `RSC_BRAIN_ADMIN_PASSWORD`, hostname-only `RSC_BRAIN_DOMAIN`, and `RSC_BRAIN_INGRESS__PUBLIC_ORIGIN=https://<same-hostname>`. |

Inject `RSC_BRAIN_INGRESS__PUBLIC_ORIGIN` into API and worker through the private model overlay shown
above. A host or platform variable that is not declared in a service environment is not passed into
the container. Keep the same complete file set when validating and deploying.

The public route ownership is identical on every target:

| Owner | Paths |
|---|---|
| Python service | `/api/v1`, `/mcp`, `/oauth`, `/.well-known`, `/metrics` |
| Next.js console | `/`, `/api/auth`, `/api/proxy` |

This map has a known 0.13.0 defect: the API also serves `/hunt/{token}`, but none of the packaged
edges route `/hunt` to it. SMTP or Slack can therefore deliver an unusable reply link even when
`RSC_BRAIN_INGRESS__PUBLIC_ORIGIN` is correct. Treat public hunt replies as unavailable on Compose,
Coolify, Dokploy, and Helm until the route map and its live traversal test include `/hunt`.

It has a second collision: the Next.js console implements a product page at `/metrics`, but every
packaged edge assigns that path to the API's protected Prometheus endpoint. No 0.13.0 credential can
satisfy `operator.metrics.read`. The scrape endpoint and console page are therefore both unavailable
through the packaged public route map.

## Kubernetes and Helm

The chart lives in [`helm/rsc-brain/`](helm/rsc-brain/). Its
[README](helm/rsc-brain/README.md) documents the required values, capability `extraEnv`, generated
Secret, migration Job, and verification flow. The [parity table](helm/PARITY.md) records deliberate
differences from Compose.

The chart fixes its PVCs to `ReadWriteOnce`, exposes no RWX value, and supplies no API/worker
co-scheduling rule. A multi-node deployment is unsupported unless the storage backend permits
compatible RWO attachment for the scheduled pods or the operator enforces co-location outside the
chart. Selecting an RWX-capable storage class does not change the claims' requested access mode.

## Credentials and persistence

- Compose installations should supply the generated admin password from `deploy/.env` explicitly.
- Helm generates a password into a Kubernetes Secret when `admin.password` is empty. Retrieve it
  with the command printed by the chart notes; it is not emitted in migration logs.
- `db_data` or the database PVC stores relational, graph, and vector state.
- `app_data` stores original source documents and must be shared by API and worker.
- `inbox` reserves the watcher layout and is separate from stored blobs. No deployed process starts
  the watcher in 0.13.0, so it is not an operative source transport.
- Compose runs API and worker as UID `10001`; Helm uses UID `1000`. Neither target initializes volume
  ownership. Provision writable ownership before ingestion and retain a successful live-write smoke.

Create a [backup](../docs/how-to/backup-and-restore.md) before an
[upgrade](../docs/how-to/upgrade.md). A snapshot does not include deployment configuration or
secrets.

## Verification evidence and limits

CI builds the database image, runs the full data-service suite, traverses the Caddy route matrix,
checks Compose-to-Helm drift, lints the chart, and validates default and production-like rendered
manifests. Release workflows generate an SPDX SBOM and scan the repository for high-severity CVEs.

Those gates do not prove DNS, certificates, a live model provider, a real Coolify or Dokploy
instance, a clean-cluster Helm installation, writable volume ownership, OAuth consent in a
third-party client, or restore in your environment. Treat those as release or deployment-specific
checks and retain their evidence.
