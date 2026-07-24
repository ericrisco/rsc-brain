#!/usr/bin/env bash
# Reference end-to-end install on a throwaway kind cluster (SPEC-25 §4.9). This is the reproducible
# recipe the release runs on a clean cluster; it needs Docker + kind + kubectl + helm and BUILT
# images, so it is a per-release step (like SPEC-18's real-instance verification), not a CI unit.
#
# It exercises AC#1/#2: helm install → migrate Job → probes green → `brain verify` 100%.
# The live cert-manager/ClusterIssuer + real Claude/ChatGPT OAuth (AC#6) run against a real cluster.
set -euo pipefail

CLUSTER="${CLUSTER:-rsc-brain-e2e}"
NS="${NS:-rsc-brain}"
CHART="$(cd "$(dirname "$0")/rsc-brain" && pwd)"
ROOT="$(git -C "$CHART" rev-parse --show-toplevel)"

echo "==> Building images"
docker build -t rsc-brain/app:e2e -f "$ROOT/Dockerfile" "$ROOT"
docker build -t rsc-brain/console:e2e -f "$ROOT/apps/admin/Dockerfile" "$ROOT/apps/admin"
docker build -t rsc-brain/db:pg16-age-pgvector -f "$ROOT/docker/db.Dockerfile" "$ROOT"

echo "==> Creating kind cluster $CLUSTER"
kind create cluster --name "$CLUSTER"
kind load docker-image rsc-brain/app:e2e rsc-brain/console:e2e rsc-brain/db:pg16-age-pgvector --name "$CLUSTER"

echo "==> helm install (ingress disabled for the in-cluster smoke; no cert-manager needed)"
helm install rsc-brain "$CHART" --namespace "$NS" --create-namespace \
  --set image.tag=e2e --set image.db.tag=pg16-age-pgvector \
  --set image.pullPolicy=Never --set ingress.enabled=false --wait --timeout 10m

echo "==> Waiting for the migrate Job"
kubectl -n "$NS" wait --for=condition=complete job -l app.kubernetes.io/component=migrate --timeout=5m

echo "==> Waiting for api readiness (= brain verify)"
kubectl -n "$NS" rollout status deploy/rsc-brain-api --timeout=5m

echo "==> brain verify"
kubectl -n "$NS" exec deploy/rsc-brain-api -- brain verify

echo "==> OK. Tear down with: kind delete cluster --name $CLUSTER"
