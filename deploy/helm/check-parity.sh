#!/usr/bin/env bash
# Drift guard (SPEC-25 §4.1): the Helm chart is DERIVED from the canonical production compose, so
# the two must never diverge silently. This records the hash of docker-compose.prod.yml that the
# chart + PARITY.md were last reconciled against. If the compose changes, this fails — the fix is
# to update the chart + PARITY.md and re-record the hash in the SAME PR, then:
#   shasum -a 256 deploy/docker-compose.prod.yml > deploy/helm/COMPOSE_SOURCE.sha256
# (the path column is intentional — `shasum -c` verifies file + hash together).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
RECORD="deploy/helm/COMPOSE_SOURCE.sha256"

if [[ ! -f "$RECORD" ]]; then
  echo "parity guard: missing $RECORD" >&2
  exit 1
fi

if shasum -a 256 -c "$RECORD" >/dev/null 2>&1; then
  echo "parity guard OK: chart is reconciled with $(awk '{print $2}' "$RECORD")."
else
  echo "parity guard FAILED: the canonical compose changed without updating the Helm chart." >&2
  echo "Reconcile deploy/helm/rsc-brain + deploy/helm/PARITY.md, then re-record:" >&2
  echo "  shasum -a 256 deploy/docker-compose.prod.yml > $RECORD" >&2
  exit 1
fi
