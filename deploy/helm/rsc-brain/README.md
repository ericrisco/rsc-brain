# rsc-brain Helm chart

This chart deploys one rsc-brain instance to Kubernetes. It creates PostgreSQL with AGE and
pgvector, a migration Job, API and worker Deployments, the administration console, persistent
volumes, and an optional Ingress.

The chart is alpha and requires an operator-supplied model configuration. Default values render and
pass schema validation, but they do not define four required capability routes or guarantee a
reachable embedder.

## Cluster prerequisites

- Kubernetes 1.27 or newer and Helm 3.12 or newer.
- A default storage class, or explicit classes for every PVC, with ownership writable by the
  configured application UID.
- An ingress controller when `ingress.enabled` is true.
- cert-manager and a working `ClusterIssuer` when the chart should emit TLS configuration.
- Images for app, console, and the PostgreSQL/AGE/pgvector data service in a registry the cluster can
  pull.
- A network-reachable model provider with all configured models installed.
- For in-cluster Ollama with GPU: node drivers and the NVIDIA device plugin.

The chart fixes every PVC to `ReadWriteOnce`, does not expose an RWX access-mode value, and does not
co-schedule API and worker. Its supported portable shape is single-node or operator-enforced
co-location. A multi-node installation requires a backend that permits compatible RWO attachment for
the actual pod placement; selecting an RWX-capable storage class does not change the requested mode.

## Create a values file

Save the following as `values.production.yaml`, then pin images and set ingress values. Configure
the embedder under `gateway.embedder` and the other four required routes under `extraEnv`:

```yaml
image:
  registry: registry.example.com/acme
  tag: "0.13.0"

ingress:
  enabled: true
  className: nginx
  domain: brain.example.com
  clusterIssuer: letsencrypt-prod

gateway:
  embedder:
    provider: ollama
    model: bge-m3
    apiBase: http://model-gateway.models.svc.cluster.local:11434

extraEnv:
  - name: RSC_BRAIN_INGRESS__PUBLIC_ORIGIN
    value: https://brain.example.com
  - name: RSC_BRAIN_CAPABILITIES__EXTRACTOR__PROVIDER
    value: ollama
  - name: RSC_BRAIN_CAPABILITIES__EXTRACTOR__MODEL
    value: qwen2.5:14b-instruct
  - name: RSC_BRAIN_CAPABILITIES__EXTRACTOR__API_BASE
    value: http://model-gateway.models.svc.cluster.local:11434
  - name: RSC_BRAIN_CAPABILITIES__JUDGE__PROVIDER
    value: ollama
  - name: RSC_BRAIN_CAPABILITIES__JUDGE__MODEL
    value: qwen2.5:14b-instruct
  - name: RSC_BRAIN_CAPABILITIES__JUDGE__API_BASE
    value: http://model-gateway.models.svc.cluster.local:11434
  - name: RSC_BRAIN_CAPABILITIES__TOPICALIZER__PROVIDER
    value: ollama
  - name: RSC_BRAIN_CAPABILITIES__TOPICALIZER__MODEL
    value: llama3.1:8b-instruct
  - name: RSC_BRAIN_CAPABILITIES__TOPICALIZER__API_BASE
    value: http://model-gateway.models.svc.cluster.local:11434
  - name: RSC_BRAIN_CAPABILITIES__RERANKER__PROVIDER
    value: ollama
  # A CHAT model, not a cross-encoder — the reranker calls `complete_structured` (AUDIT-085). Note
  # that `extraEnv` OVERRIDES `capabilities.reranker.model` from values.yaml, so a cross-encoder
  # copied in here disables abstention on a chart whose own default is correct (AUDIT-097).
  - name: RSC_BRAIN_CAPABILITIES__RERANKER__MODEL
    value: qwen2.5:3b-instruct
  - name: RSC_BRAIN_CAPABILITIES__RERANKER__API_BASE
    value: http://model-gateway.models.svc.cluster.local:11434
```

Use a 1024-dimensional embedder. If a capability needs an API key, add a Kubernetes Secret and use
an `extraEnv` entry with `valueFrom.secretKeyRef`; do not put the credential in a values file.

`extraEnv` is rendered only into the API and worker containers. Capability variables and
`valueFrom.secretKeyRef` credentials therefore do not reach the console. For an explicit
console-only non-secret setting, use `console.extraEnv`; do not use it for model credentials.

`ingress.public_origin` controls OAuth metadata, generated hunt links, and the MCP Host and Origin
allow-list. The chart's 0.13.0 Ingress does not route `/hunt` to the API, however, so public hunt
replies remain unavailable even with the origin configured.

The same Ingress routes `/metrics` to the API's Prometheus endpoint. No 0.13.0 principal can satisfy
that endpoint's operator capability, and the route shadows the console product-metrics page at the
same path. Neither surface is reachable through the chart's public Ingress.

The inbox PVC reserves the folder-watcher layout. The API and worker mount it, but neither process
starts the watcher in 0.13.0; copying a file into the claim does not enqueue ingestion.

## Provision application-volume ownership

The default pod security context runs the application as UID `1000`. The chart has no ownership init
container and no `fsGroup`, so a fresh root-owned application-data or inbox PVC can reject writes.
Before ingestion, provision both claims through the storage backend for UID `1000` or for the UID
selected in `securityContext.runAsUser`. This may require pre-provisioned storage or a controlled
one-time cluster task after claim creation; the chart does not perform the mutation.

Storage-class selection, PVC `Bound` state, `helm lint`, and rendered-manifest validation do not
prove the live write path. Do not begin ingestion until both API and worker write probes below pass.

## Install

Review the render before changing the cluster:

```bash
helm lint deploy/helm/rsc-brain
(
  umask 077
  rendered="$(mktemp "${TMPDIR:-/tmp}/rsc-brain-rendered.XXXXXX")"
  trap 'rm -f -- "$rendered"' EXIT
  helm template rsc-brain deploy/helm/rsc-brain \
    --namespace rsc-brain \
    -f values.production.yaml > "$rendered"
  less "$rendered"
)
```

`helm template` renders generated Secret manifests. The example creates a mode-0600 temporary file
inside a subshell, so it is deleted immediately after review and the restrictive umask does not
alter the caller's shell. Do not redirect a full render to a shared or long-lived path.

Install and wait for the migration and workloads:

```bash
helm install rsc-brain deploy/helm/rsc-brain \
  --namespace rsc-brain \
  --create-namespace \
  -f values.production.yaml \
  --wait \
  --wait-for-jobs \
  --timeout 10m
```

The migration Job is an ordinary resource named with the Helm revision. It is not a lifecycle hook.
API and worker init containers wait until the database reports the exact schema head.

## Retrieve the first-admin credential

When `admin.password` is empty, the chart generates the password in its Kubernetes Secret and
preserves the Secret across upgrades. Retrieve it from the location named by the chart notes:

```bash
kubectl -n rsc-brain get secret rsc-brain-secrets \
  -o jsonpath='{.data.RSC_BRAIN_ADMIN_PASSWORD}' | base64 -d; echo
```

The exact Secret name follows the Helm release fullname rules; use `helm get notes rsc-brain` when
the release name or overrides differ. The password is not printed by the migration Job.

## Verify

```bash
kubectl -n rsc-brain get jobs,pods,pvc
kubectl -n rsc-brain exec deploy/rsc-brain-api -- brain verify --json
kubectl -n rsc-brain exec deploy/rsc-brain-api -- \
  sh -ceu 'p=/var/lib/rsc-brain/data/.write-probe; : > "$p"; rm "$p"'
kubectl -n rsc-brain exec deploy/rsc-brain-worker -- \
  sh -ceu 'p=/var/lib/rsc-brain/data/.write-probe; : > "$p"; rm "$p"'
```

`brain verify` checks complete capability configuration, AGE and pgvector, and the exact migration
head. It performs no provider request and does not write the PVC. Both write probes must exit `0`.
Verify provider reachability from both API and worker pods, then perform an authorized
ingest-to-recall check.

## Optional in-cluster Ollama

The chart can create an Ollama Deployment, Service, and model-cache PVC:

```yaml
ollama:
  enabled: true
  gpu:
    enabled: true

gateway:
  embedder:
    provider: ollama
    model: bge-m3
    apiBase: http://rsc-brain-ollama:11434
```

Adjust the service name when Helm fullname overrides or a different release name changes it. The
chart does not pull models into Ollama. Configure all five capabilities and make their models
available before ingestion or recall.

## Upgrade from chart 0.13.x

Chart 0.14.0 narrows top-level `extraEnv` to the Python API and worker. In chart 0.13.x those entries
also reached the Next.js console, which could expose capability credentials to a process that did not
need them. Before upgrading, move console-only entries from top-level `extraEnv` to `console.extraEnv`;
leave model routes, `RSC_BRAIN_INGRESS__PUBLIC_ORIGIN`, and credential
`valueFrom` references at top level. The chart-only minor version changes while `appVersion` remains
0.13.0 because the application images are unchanged.

Then create a verified backup and upgrade:

```bash
helm upgrade rsc-brain deploy/helm/rsc-brain \
  --namespace rsc-brain \
  -f values.production.yaml \
  --set image.tag=0.13.0 \
  --wait \
  --wait-for-jobs \
  --timeout 10m
```

PVCs and the generated Secret carry a keep policy. This reduces accidental removal by Helm but does
not replace backups or cluster storage protection. See the public
[upgrade guide](../../../docs/how-to/upgrade.md).

The [Compose-to-Helm parity table](../PARITY.md) documents resource mapping and deliberate platform
differences. [`../e2e.sh`](../e2e.sh) is an environment-dependent kind recipe, not a CI proof of
production TLS, models, or OAuth client compatibility.
