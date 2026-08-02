# Compose ↔ Helm parity (SPEC-25, principle D18)

The Helm chart is derived from the canonical production Compose file
([`deploy/docker-compose.prod.yml`](../docker-compose.prod.yml)) — it is a packaging, not a
reimplementation. Every compose service, volume, secret, and healthcheck maps 1:1 to a chart
resource below. A CI **drift guard** ([`check-parity.sh`](check-parity.sh)) records the compose's
sha256 in [`COMPOSE_SOURCE.sha256`](COMPOSE_SOURCE.sha256) and fails if the compose changes without
the chart being reconciled.

**Process rule:** any change to `docker-compose.prod.yml` must update this chart, this table, and
the recorded hash in the same pull request.

## Services

| Compose service | Chart resource(s) | Notes |
|---|---|---|
| `db` (image `rsc-brain/db:pg16-age-pgvector`) | `db-statefulset.yaml` (StatefulSet + headless Service) | Single D1 image; `pg_isready` → readiness/liveness probes (parity with the compose healthcheck). |
| `migrate` (`brain init`, one-shot) | `migrate-job.yaml` (ordinary Job, named per release revision) | Sole migrator; `wait-for-db` initContainer replaces compose `depends_on: db healthy`. Idempotent (FR-2.3). NOT a Helm hook (R49): a `post-install` hook runs *after* `--wait` has waited for the api, whose readiness needs the schema the hook has not applied — a deadlock. `pre-install` cannot work either, because the database is a resource of this same chart. |
| `api` (`brain verify` healthcheck) | `api-deployment.yaml` (Deployment + ClusterIP Service) | Readiness = `brain verify` (same check, FR-11.2). Exposed only via Ingress. |
| `worker` (`python -m rsc_brain.worker`) | `worker-deployment.yaml` (Deployment) | No healthcheck in compose ⇒ no probes; k8s restarts on process exit. |
| `console` (Next.js) | `console-deployment.yaml` (Deployment + ClusterIP Service) | `API_URL` → the api Service. Exposed only via Ingress. |
| `caddy` (automatic TLS) | **Ingress + cert-manager** (`ingress.yaml`) | Dropped on k8s — same as the Coolify/Dokploy overlays, where the target's proxy terminates TLS. cert-manager is a declared cluster prerequisite (D8). |

## Volumes

| Compose volume | Chart resource | Notes |
|---|---|---|
| `db_data` | StatefulSet `volumeClaimTemplates: db-data` | Postgres data (graph + relational). |
| `app_data` | PVC `<release>-app-data` | The stored SOURCE DOCUMENTS (R39); mounted on API + worker at `/var/lib/rsc-brain/data`, which is `RSC_BRAIN_INGEST__DATA_DIR`. Helm uses UID `1000`, while Compose uses UID `10001`; neither target initializes volume ownership. |
| `inbox` | PVC `<release>-inbox` | Reserved watcher layout mounted on API + worker at `/var/lib/rsc-brain/data/inbox`. No packaged 0.13.0 process starts the watcher, so the volume is not an operative source transport. |
| _(none)_ | PVC `<release>-model-cache` | Ollama/HF weights; mounted on worker (+ opt-in in-cluster ollama). Chart-only: the compose declares no model cache, because Ollama is a host precondition there (D8) and no compose service would mount it. |
| `caddy_data`, `caddy_config` | — (N/A) | Caddy is dropped; the Ingress controller + cert-manager hold TLS state. |

## Secrets / config

| Compose env | Chart resource | Notes |
|---|---|---|
| `POSTGRES_PASSWORD` | `secrets.yaml` (k8s Secret) | Database credential; auto-generated when blank and preserved across upgrades (`lookup` helper, FR-4.7). A rendered Secret exposes `stringData`, so full `helm template` output must remain private and short-lived. |
| `RSC_BRAIN_DATABASE__DSN` (derived) | Secret (built from the same password) | External DB override via `database.dsn`. |
| `RSC_BRAIN_ADMIN_EMAIL` / `_PASSWORD` | Secret | First-admin bootstrap. A blank chart value is generated and preserved in the Secret; it is not printed by the migration Job. Compose operators must supply it explicitly because that migration container has no persistent credential-file mount. |
| `RSC_BRAIN_DOMAIN`, `RSC_BRAIN_CAPABILITIES__EMBEDDER__*` | `configmap.yaml` (ConfigMap) | Non-secret app config injected through `envFrom`. These fields do not satisfy the four other required capabilities. |
| Additional `RSC_BRAIN_CAPABILITIES__*` values | Compose environment override / chart `extraEnv` | Required for extractor, judge, topicalizer, and reranker. Helm injects `extraEnv` only into API + worker; it may carry `valueFrom.secretKeyRef` credentials and never reaches the console. Neither packaging target supplies a complete model configuration by default. |
| Console-only environment | Console environment / chart `console.extraEnv` | Explicit non-secret console settings only. This separates the Next.js process from application capability routes and credential refs. |

**Chart 0.14.0 migration:** chart 0.13.x also injected top-level `extraEnv` into the console. Move
console-only entries to `console.extraEnv` before upgrading; keep capability routes, public origin,
and Secret references in top-level `extraEnv` for API and worker.

## Documented deltas (k8s-specific, not drift)

- **Caddy → Ingress + cert-manager**: the standard k8s idiom; cert-manager is a cluster prereq (D8),
  not installed by the chart. Same pattern as the PaaS overlays.
- **`depends_on` → init containers**: k8s has no compose-style `depends_on`. The migrate Job is the sole
  migrator and an ordinary resource. Published install commands use `--wait --wait-for-jobs`; api and
  worker also carry a `wait-for-schema` initContainer, so each pod stays in Init until the schema is at head.
  That is the equivalent of `service_completed_successfully` — and it is what R49 required: the app waits
  for the migration instead of the installer waiting for the app while the app waits for the migration.
  `brain verify` readiness remains, but as a health signal rather than as the ordering mechanism.
- **`security_opt: no-new-privileges` → `securityContext` (runAsNonRoot)**: the k8s pod-security
  equivalent. The chart's UID is `1000`, not the image's Compose UID `10001`; neither packaging
  target initializes mounted-volume ownership.
- **Fixed RWO claims**: database, application data, inbox, and model-cache PVCs request
  `ReadWriteOnce`. API and worker share two claims, but the chart supplies no co-scheduling or RWX
  value. Multi-node placement is unsupported unless the backend permits compatible RWO attachment or
  the operator enforces co-location outside the chart.
- **Reserved inbox**: the claim preserves a future watcher layout, but the packaged worker command
  starts only the queue worker. It does not start the folder watcher in 0.13.0.
- **GPU (D8)**: host precondition in both. The chart adds an opt-in in-cluster Ollama Deployment for
  GPU-ready clusters. The default embedder URL is a placeholder unless an operator supplies a
  matching network service or changes it.

## Readiness and deployment evidence

`brain verify` checks complete capability configuration and local database readiness. It does not
call the configured provider, pull models, or run ingestion and recall. Helm lint, kubeconform, and
the parity hash prove packaging structure; they do not prove a live cluster, TLS issuer, writable
volume ownership, compatible RWO scheduling, provider, or third-party OAuth client. A deployment
requires live write probes from API and worker.
