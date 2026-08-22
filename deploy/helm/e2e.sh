#!/usr/bin/env bash
# Reference end-to-end install on a throwaway kind cluster (SPEC-25 §4.9). This is the reproducible
# recipe the release runs on a clean cluster; it needs Docker + kind + kubectl + helm and BUILT
# images, so it is a per-release step (like SPEC-18's real-instance verification), not a CI unit.
#
# It exercises chart install, migration ordering, readiness, and the HTTP route map. It supplies
# placeholder non-embedder capability routes because readiness checks configuration completeness but
# does not call providers. Live model, cert-manager/TLS, and third-party OAuth checks are separate.
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
# AppConfig requires provider + model for all five roles. Embedder comes from chart values; these
# four placeholder routes let the readiness-only recipe start without claiming a provider was tested.
# The explicit HTTP origin matches this no-TLS kind fixture and lets MCP validate the forwarded Host.
EXTRA_ENV_JSON='[{"name":"RSC_BRAIN_INGRESS__PUBLIC_ORIGIN","value":"http://rsc-brain.local"},{"name":"RSC_BRAIN_CAPABILITIES__EXTRACTOR__PROVIDER","value":"ollama"},{"name":"RSC_BRAIN_CAPABILITIES__EXTRACTOR__MODEL","value":"qwen2.5:14b-instruct"},{"name":"RSC_BRAIN_CAPABILITIES__JUDGE__PROVIDER","value":"ollama"},{"name":"RSC_BRAIN_CAPABILITIES__JUDGE__MODEL","value":"qwen2.5:14b-instruct"},{"name":"RSC_BRAIN_CAPABILITIES__TOPICALIZER__PROVIDER","value":"ollama"},{"name":"RSC_BRAIN_CAPABILITIES__TOPICALIZER__MODEL","value":"llama3.1:8b-instruct"},{"name":"RSC_BRAIN_CAPABILITIES__RERANKER__PROVIDER","value":"ollama"},{"name":"RSC_BRAIN_CAPABILITIES__RERANKER__MODEL","value":"qwen2.5:14b-instruct"}]'
helm install rsc-brain "$CHART" --namespace "$NS" --create-namespace \
  --set image.tag=e2e --set image.db.tag=pg16-age-pgvector \
  --set image.pullPolicy=Never \
  --set ingress.enabled=true --set ingress.domain=rsc-brain.local \
  --set-json "extraEnv=${EXTRA_ENV_JSON}" \
  --wait --wait-for-jobs --timeout 10m

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
kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller 18080:80 >/dev/null 2>&1 &
PF_PID=$!
trap 'kill $PF_PID 2>/dev/null || true' EXIT
sleep 3

# Exact unauthenticated statuses are the ownership fingerprint. A generic "anything but 404" check
# lets the console's real /metrics page masquerade as the API metrics endpoint, so it is not evidence.
declare -a ROUTE_PROBES=(
  "service|/api/v1/admin/projects|401"
  "service|/mcp|406"
  "service|/oauth/authorize|401"
  "service|/.well-known/oauth-authorization-server|200"
  "service|/metrics|401"
  "console|/|200"
  "console|/api/auth/login|405"
  "console|/api/proxy/api/v1/admin/projects|401"
)

fail=0
for probe in "${ROUTE_PROBES[@]}"; do
  IFS='|' read -r owner path expected <<< "$probe"
  if ! code=$(curl --silent --show-error --max-time 10 --output /dev/null \
    --write-out "%{http_code}" --header "Host: rsc-brain.local" \
    "http://127.0.0.1:18080${path}"); then
    echo "  FAIL $owner $path — request did not complete"
    fail=1
    continue
  fi
  if [[ "$code" != "$expected" ]]; then
    echo "  FAIL $owner $path — expected HTTP $expected, got $code"
    fail=1
  else
    echo "  ok   $owner $path -> HTTP $code"
  fi
done
[[ "$fail" == "0" ]] || { echo "==> R56: the live Ingress does not honour the route map"; exit 1; }

echo "==> OK. Tear down with: kind delete cluster --name $CLUSTER"
