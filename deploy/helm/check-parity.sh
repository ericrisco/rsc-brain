#!/usr/bin/env bash
# Drift guard (SPEC-25 §4.1): the Helm chart and the install-by-version topology are both DERIVED
# from the canonical production compose, so none of the three may diverge silently. This records the
# hash of every guarded file as last reconciled. If one changes, this fails — the fix is to update
# the chart + PARITY.md and re-record ALL of them in the SAME PR:
#   shasum -a 256 deploy/docker-compose.prod.yml deploy/docker-compose.version.yml > deploy/helm/COMPOSE_SOURCE.sha256
# (the path column is intentional — `shasum -c` verifies file + hash together.)
#
# Re-recording only the canonical file drops the other from the guard, silently. This header said
# exactly that for one commit after the second file was added: an instruction that disarms the
# protection it is printed to restore. The error path below was fixed and this was not — a fix
# applied to the loud copy of a sentence and not to the quiet one.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
RECORD="deploy/helm/COMPOSE_SOURCE.sha256"

if [[ ! -f "$RECORD" ]]; then
  echo "parity guard: missing $RECORD" >&2
  exit 1
fi

if shasum -a 256 -c "$RECORD" >/dev/null 2>&1; then
  echo "parity guard OK: reconciled with $(awk '{printf "%s ", $2}' "$RECORD")"
else
  echo "parity guard FAILED: a guarded deployment definition changed without reconciling." >&2
  shasum -a 256 -c "$RECORD" 2>&1 | grep -v ': OK$' | sed 's/^/  /' >&2
  echo "Reconcile deploy/helm/rsc-brain + deploy/helm/PARITY.md, then re-record BOTH files:" >&2
  # Re-recording only the canonical file would silently drop the other from the guard — an
  # instruction that breaks the protection it is printed to restore.
  echo "  shasum -a 256 deploy/docker-compose.prod.yml deploy/docker-compose.version.yml > $RECORD" >&2
  exit 1
fi
