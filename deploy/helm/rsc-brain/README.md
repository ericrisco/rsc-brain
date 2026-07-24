# rsc-brain Helm chart (Kubernetes target — SPEC-25)

Deploy one self-hosted rsc-brain instance to Kubernetes. This chart is **derived 1:1 from the
canonical production compose** ([parity table](../PARITY.md)) — the third thin delta after the
Coolify/Dokploy overlays (principle D18), so the targets can't drift.

Plug-and-play (FR-18.x): auto-generated secrets, migrate-on-boot, `brain verify` probes,
first-admin bootstrap, persistent volumes — **zero hand-editing** beyond a minimal `values.yaml`.

## Cluster prerequisites (declared, not installed — D8)

- A Kubernetes cluster (1.27+) and `helm` 3.12+.
- An **ingress controller** (e.g. ingress-nginx) — `ingress.className` (default `nginx`).
- **cert-manager** with a working `ClusterIssuer` — required for TLS, and TLS is a hard prereq for
  OAuth to Claude/ChatGPT (D11). Set `ingress.clusterIssuer`.
- A **storage class** for `ReadWriteOnce` PVCs. On a multi-node cluster where api + worker may land
  on different nodes, set an **RWX** storage class for `persistence.inbox`/`persistence.modelCache`.
- **GPU (optional)**: the NVIDIA device plugin + drivers are the host's responsibility (D8). The
  chart never installs them.

## Install

```bash
helm install rsc-brain deploy/helm/rsc-brain \
  --namespace rsc-brain --create-namespace \
  --set ingress.domain=brain.acme.com \
  --set ingress.clusterIssuer=letsencrypt-prod \
  --set image.registry=ghcr.io/ericrisco --set image.tag=v1.0.0
```

That is the whole happy path: a domain, a cert-manager issuer, and the image coordinates. Postgres
password + first-admin password are generated automatically. Retrieve the admin password (never
printed in plaintext by the chart):

```bash
kubectl -n rsc-brain get secret rsc-brain-secrets \
  -o jsonpath='{.data.RSC_BRAIN_ADMIN_PASSWORD}' | base64 -d ; echo
```

Then log in at `https://brain.acme.com/`; the MCP endpoint is `https://brain.acme.com/mcp`.

## Upgrade (NFR-8 — no data loss)

```bash
helm upgrade rsc-brain deploy/helm/rsc-brain --reuse-values --set image.tag=v1.1.0
```

The `pre-upgrade` migrate Job runs `brain init` (idempotent migrations) **before** the new api/worker
roll out. Named PVCs (`helm.sh/resource-policy: keep`) and the Secret survive; secrets are **not**
rotated. Take a `brain backup` first for safety.

## Model gateway (GPU / D8)

- **Default — external endpoint** (a GPU host or managed service):
  `--set gateway.embedder.apiBase=https://ollama.internal:11434`
- **Opt-in in-cluster Ollama** (only on a GPU-ready cluster):
  `--set ollama.enabled=true --set ollama.gpu.enabled=true` (+ `ollama.nodeSelector`/`tolerations`),
  then `--set gateway.embedder.apiBase=http://rsc-brain-ollama:11434`.

`brain doctor` reports the configured endpoint.

## Verify

```bash
kubectl -n rsc-brain exec deploy/rsc-brain-api -- brain verify   # same check as the api readiness probe
```

See [`values.yaml`](values.yaml) for the full, commented surface, and [PARITY.md](../PARITY.md) for
the compose↔chart mapping. A reference end-to-end install (kind) lives in [`../e2e.sh`](../e2e.sh).
