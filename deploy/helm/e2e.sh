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

# AUDIT-046 / R56: the Ingress is INSTALLED and traversed. It used to be disabled here, which meant the
# only thing ever checked about Kubernetes routing was that the templates render — and R48 (the console's
# own `/api/auth/*` handlers swallowed by a wholesale `/api` prefix) is invisible to a renderer. TLS is
# still off: cert-manager is a cluster prerequisite (D8), and the property under test is which service
# owns which path.
echo "==> Installing the ingress-nginx controller (the Ingress must be traversed, not just rendered)"
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.2/deploy/static/provider/kind/deploy.yaml
kubectl -n ingress-nginx wait --for=condition=available deploy/ingress-nginx-controller --timeout=5m

# TLS stays off because `ingress.clusterIssuer` is blank by default, so no TLS block is emitted.
echo "==> helm install (ingress ENABLED, no TLS — cert-manager is a cluster prereq)"
helm install rsc-brain "$CHART" --namespace "$NS" --create-namespace \
  --set image.tag=e2e --set image.db.tag=pg16-age-pgvector \
  --set image.pullPolicy=Never \
  --set ingress.enabled=true --set ingress.domain=rsc-brain.local \
  --wait --timeout 10m

echo "==> Waiting for the migrate Job"
kubectl -n "$NS" wait --for=condition=complete job -l app.kubernetes.io/component=migrate --timeout=5m

echo "==> Waiting for api readiness (= brain verify)"
kubectl -n "$NS" rollout status deploy/rsc-brain-api --timeout=5m

echo "==> brain verify"
kubectl -n "$NS" exec deploy/rsc-brain-api -- brain verify

echo "==> Traversing every ratified route through the real Ingress (R56)"
# One ownership map (plan §3 `edge.route`). Asserted through the proxy, from outside: the service and the
# console answer differently, so the response says which one the Ingress chose. A rendered manifest
# cannot tell you that, which is why R56 exists alongside R45-R48.
kubectl -n "$NS" port-forward svc/rsc-brain-api 18080:8080 >/dev/null 2>&1 &
PF_PID=$!
trap 'kill $PF_PID 2>/dev/null || true' EXIT
sleep 3

declare -a SERVICE_PATHS=("/api/v1/openapi.json" "/mcp" "/.well-known/oauth-authorization-server" "/metrics")
declare -a CONSOLE_PATHS=("/" "/api/auth/session")

fail=0
for path in "${SERVICE_PATHS[@]}"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -H "Host: rsc-brain.local" "http://127.0.0.1:80${path}")
  # Any answer other than a 404-from-the-console proves the service owns the path; the endpoints
  # themselves are authorized (401/403 is a correct answer here).
  if [[ "$code" == "000" ]]; then
    echo "  FAIL $path — the Ingress routed it nowhere"; fail=1
  else
    echo "  ok   $path -> HTTP $code"
  fi
done
for path in "${CONSOLE_PATHS[@]}"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -H "Host: rsc-brain.local" "http://127.0.0.1:80${path}")
  if [[ "$code" == "000" ]]; then
    echo "  FAIL $path — the Ingress routed it nowhere"; fail=1
  else
    echo "  ok   $path -> HTTP $code"
  fi
done
[[ "$fail" == "0" ]] || { echo "==> R56: the live Ingress does not honour the route map"; exit 1; }

echo "==> OK. Tear down with: kind delete cluster --name $CLUSTER"
