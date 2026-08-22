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
| `RSC_BRAIN_DOMAIN`, all five `RSC_BRAIN_CAPABILITIES__*` routes and their `EGRESS` grants | `configmap.yaml` (ConfigMap) | Non-secret app config injected through `envFrom`. Both targets ship complete local Ollama routes; HTTP and private-network access are explicit per capability rather than weakened in the application default. |
| Additional `RSC_BRAIN_CAPABILITIES__*` values | Compose environment override / chart `extraEnv` | Optional provider/model/credential overrides. Helm injects `extraEnv` only into API + worker; it may carry `valueFrom.secretKeyRef` credentials and never reaches the console. A public HTTPS override must also set both egress grants false. |
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

## 2026-08-13 — capability defaults and project-name isolation

Reconciled after a real-host install run changed the canonical compose:

- **All five capability layers now carry defaults** in both targets (`x-app-env` in the compose,
  `gateway.*` in `values.yaml` rendered by the ConfigMap). Previously each declared the embedder
  only and told the operator to supply the other four, which meant twenty hand-authored entries
  before anything would start.
- **The compose's embedder default was `nomic-embed-text`, which returns 768 dimensions** — the
  gateway anchors at 1024 and refuses anything else, so a fresh `docker compose up` could not
  start. Measured on a host, not inferred. The chart already had `bge-m3` and was unaffected; this
  is the one case so far where the Kubernetes target was correct and the primary one was not.
- **The compose project name moved to `rsc-brain-prod`** (and both overlays with it) because it
  collided with the root topology's `rsc-brain`, sharing `db_data`. Postgres applies its password
  only on first initialisation, so an operator who followed the phased installer and then this path
  met a bare "password authentication failed". Helm is unaffected: its release name already scopes
  its resources.

### AUDIT-084 / AUDIT-085 — the reranker switch, and a route that could serve it

Compose declared the reranker's three route variables and **not** `RSC_BRAIN_RERANKER__ENABLED`, so an
operator who set it in `.env` got nothing: `--env-file` feeds interpolation, and a container receives
only what the compose file declares. The topology carried the configuration for a capability that
could never run.

| Concern | Compose | Chart |
| --- | --- | --- |
| `reranker.enabled` | `RSC_BRAIN_RERANKER__ENABLED`, default `false` | `.Values.reranker.enabled`, default `false`, rendered by the configmap |
| reranker route model | `qwen2.5:3b-instruct` | `qwen2.5:3b-instruct` |

Both defaults changed away from `bge-reranker-v2-m3`: it is a **cross-encoder**, and the only
implementation is LLM-based (`complete_structured`), so that route could not work on either topology.
The models may differ between the two targets — the chart has always targeted larger hardware — but
whether the route can serve the implementation must not, and a unit test pins exactly that rather than
the string.

Not verified locally: `helm lint` and the chart's rendered-security tests need the `helm` binary,
which is absent from the authoring machine. CI is the gate for the chart half of this change.

## 2026-08-19 — comment-only reconciliation (AUDIT-101)

Both compose files gained a comment on the packaged `ollama` profile: on macOS, Docker Desktop passes
no Metal through, so every model in that container runs on CPU regardless of the host. Measured on an
M4 Pro, one 10-passage reranker call took 256 s in-container and 2.5 s against a native ollama on the
same machine, against a 60 s default timeout.

**The chart is deliberately unchanged.** It has no in-cluster ollama comment to correct, and the
limitation is a Docker-Desktop-on-macOS property with no Kubernetes analogue — a cluster either has a
device plugin and drivers or it does not (D8). The hashes were re-recorded because the guard hashes
whole files, not semantics; nothing about the deployed topology moved.

## 2026-08-21 — model egress policy (AUDIT-005)

All five local Ollama routes in Compose and Helm now carry the same two explicit grants:
plain HTTP and RFC1918/ULA/loopback resolution. The application defaults for both remain false.
This preserves an installable local topology without silently authorizing an HTTPS cloud route to
rebind into the cluster network. Operators moving a capability to a public HTTPS provider set both
grants false. The canonical and versioned Compose hashes were re-recorded with this chart change.

## 2026-08-22 — the documented build could not run (AUDIT-133)

Compose gained a build argument: `RSC_BRAIN_BUILD_IDENTITY`, defaulting to `source-build`.

The Dockerfile refuses an empty build identity — on purpose, so no image can lie about which commit
it is. `release.yml` passed it and the Compose topology did not, so **every documented
`docker compose build` / `up --build` failed on a clean checkout** while CI stayed green, because CI
builds through the release workflow instead. Measured by following `deploy/README.md`:

```
failed to solve: process "/bin/sh -c test -n \"${RSC_BRAIN_BUILD_IDENTITY}\" || { ... }"
did not complete successfully: exit code: 1
```

**Nothing to reconcile in the chart, and this is why**: the chart deploys *published images*
(`image.repository` / `image.tag`) and builds nothing. A build argument has no chart counterpart —
the same reason `INSTALL_PDF_BACKEND` has none. Recorded here rather than left as an unexplained hash
bump, because "no chart change needed" is a conclusion and not an omission.

After the fix, the runbook was followed end to end on a clean checkout: image built, volume ownership
provisioned, topology up, and `brain verify` inside the api image reporting `status: ok` — **16 min
50 s** from the build command, against the <30 min gate. `brain --version` in the image answers
`0.13.0+source-build`, which is the honest identity the default is meant to produce.


## 2026-08-22 — the versioned compose file states the coupling it always had

`docker-compose.version.yml` gained a header only: no service, no environment key, no volume, no
topology. **Nothing to reconcile in the chart, and this is why**: the chart takes `image.tag` from
values and carries none of this file's environment defaults, so a comment cannot drift from it. The
hashes are re-recorded because the guard hashes bytes, which is the right thing for it to do — a guard
that tried to judge which edits "matter" would be a guard that could be argued with.

What the header now says was measured rather than reasoned. Following the documented invocation with
`main`'s copy of the file and a published version pinned:

```
RSC_BRAIN_VERSION=0.13.1-rc2 → api crash-loops:
  capabilities.embedder.egress — Extra inputs are not permitted [type=extra_forbidden]
```

`main`'s copy sets `RSC_BRAIN_CAPABILITIES__*__EGRESS__*` (AUDIT-005); `0.13.1-rc2` was published
before that field existed, and its `CapabilityConfig` has no `egress`. The coherent pairing does
exist — the copy of this file at tag `v0.13.1-rc2` carries zero EGRESS references — so the failure is
mixing a newer checkout with an older pin, which is precisely what the old example (`0.13.0`) invited.

The example is now **parametric**, and that was forced rather than chosen. The guard written for this
first demanded the example name this checkout's own version, and failed on the replacement example
immediately: **no published image corresponds to any released version of this repository.** The only
images that exist are for `v0.13.1-rc1` and `v0.13.1-rc2`; this checkout is `0.13.0`, which was tagged
before the publish job existed. So every concrete version the file could name today is either foreign
to the checkout (skew) or unpublished (pull failure). It stays parametric until a released version has
a pullable image — which is the first signed release, and that is the owner's call to make.

Verified positively in the same run, against the published image and not a local build:

- `brain --version` inside `ghcr.io/ericrisco/rsc-brain/app:0.13.1-rc2` answers **`v0.13.1-rc2`**, and
  `RSC_BRAIN_BUILD_IDENTITY` is stamped into the image. The identity a published artifact reports is
  its own — which is the whole point of SPEC release-identity, now confirmed in a shipped artifact.
- `migrate` from that image applied the schema and created the first admin: **exit 0**.
- The compose file interpolates and resolves all three images (`app`, `console`, `db`) to published
  tags.
