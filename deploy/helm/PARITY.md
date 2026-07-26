# Compose ↔ Helm parity (SPEC-25, principle D18)

The Helm chart is **derived** from the one canonical production compose
([`deploy/docker-compose.prod.yml`](../docker-compose.prod.yml)) — it is a packaging, not a
reimplementation. Every compose service, volume, secret, and healthcheck maps 1:1 to a chart
resource below. A CI **drift guard** ([`check-parity.sh`](check-parity.sh)) records the compose's
sha256 in [`COMPOSE_SOURCE.sha256`](COMPOSE_SOURCE.sha256) and fails if the compose changes without
the chart being reconciled.

**Process rule:** any change to `docker-compose.prod.yml` MUST update this chart + this table +
re-record the hash **in the same PR**.

## Services

| Compose service | Chart resource(s) | Notes |
|---|---|---|
| `db` (image `rsc-brain/db:pg16-age-pgvector`) | `db-statefulset.yaml` (StatefulSet + headless Service) | Single D1 image; `pg_isready` → readiness/liveness probes (parity with the compose healthcheck). |
| `migrate` (`brain init`, one-shot) | `migrate-job.yaml` (Job, hook `post-install,pre-upgrade`) | Sole migrator; `wait-for-db` initContainer replaces compose `depends_on: db healthy`. Idempotent (FR-2.3). |
| `api` (`brain verify` healthcheck) | `api-deployment.yaml` (Deployment + ClusterIP Service) | Readiness = `brain verify` (same check, FR-11.2). Exposed only via Ingress. |
| `worker` (`python -m rsc_brain.worker`) | `worker-deployment.yaml` (Deployment) | No healthcheck in compose ⇒ no probes; k8s restarts on process exit. |
| `console` (Next.js) | `console-deployment.yaml` (Deployment + ClusterIP Service) | `API_URL` → the api Service. Exposed only via Ingress. |
| `caddy` (automatic TLS) | **Ingress + cert-manager** (`ingress.yaml`) | Dropped on k8s — same as the Coolify/Dokploy overlays, where the target's proxy terminates TLS. cert-manager is a declared cluster prerequisite (D8). |

## Volumes

| Compose volume | Chart resource | Notes |
|---|---|---|
| `db_data` | StatefulSet `volumeClaimTemplates: db-data` | Postgres data (graph + relational). |
| `app_data` | PVC `<release>-app-data` | The stored SOURCE DOCUMENTS (R39); mounted on api + worker at `/var/lib/rsc-brain/data`, which is `RSC_BRAIN_INGEST__DATA_DIR`. Without it a replaced container loses every original while the rows still point at their paths. |
| `inbox` | PVC `<release>-inbox` | PDF drop zone (FR-1.13); mounted on api + worker at `/var/lib/rsc-brain/data/inbox`, INSIDE the data dir — the chart used to point the data dir at this volume, conflating the store with the drop zone. |
| _(none)_ | PVC `<release>-model-cache` | Ollama/HF weights; mounted on worker (+ opt-in in-cluster ollama). Chart-only: the compose declares no model cache, because Ollama is a host precondition there (D8) and no compose service would mount it. |
| `caddy_data`, `caddy_config` | — (N/A) | Caddy is dropped; the Ingress controller + cert-manager hold TLS state. |

## Secrets / config

| Compose env | Chart resource | Notes |
|---|---|---|
| `POSTGRES_PASSWORD` (the one secret) | `secrets.yaml` (k8s Secret) | Auto-generated when blank, preserved across upgrades (`lookup` helper, FR-4.7). Never plaintext in templates. |
| `RSC_BRAIN_DATABASE__DSN` (derived) | Secret (built from the same password) | External DB override via `database.dsn`. |
| `RSC_BRAIN_ADMIN_EMAIL` / `_PASSWORD` | Secret | First-admin bootstrap; password shown once in the migrate Job logs + the Secret. |
| `RSC_BRAIN_DOMAIN`, `RSC_BRAIN_CAPABILITIES__EMBEDDER__*` | `configmap.yaml` (ConfigMap) | Non-secret app config; injected via `envFrom`. |

## Documented deltas (k8s-specific, not drift)

- **Caddy → Ingress + cert-manager**: the standard k8s idiom; cert-manager is a cluster prereq (D8),
  not installed by the chart. Same pattern as the PaaS overlays.
- **`depends_on` → probes + hook ordering**: k8s has no compose-style `depends_on`. The migrate Job
  (`post-install,pre-upgrade`) is the sole migrator; the api's `brain verify` readiness keeps it out
  of the Service until the schema is at head — self-healing equivalent of `service_completed_successfully`.
- **`security_opt: no-new-privileges` → `securityContext` (runAsNonRoot)**: the k8s pod-security
  equivalent.
- **GPU (D8)**: host precondition in both. The chart adds an *opt-in* in-cluster Ollama Deployment
  for GPU-ready clusters; the default points the gateway at an external endpoint.
