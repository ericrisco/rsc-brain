#!/usr/bin/env bash
# Evidence gate: lint, types, tests, dependency audit. Exits non-zero on the first failure.
# Locally (not in CI) the tests also run against a real PostgreSQL: the one in RSC_BRAIN_PG_URL, or a
# throwaway local cluster when the server binaries are installed. CI runs without PostgreSQL.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -z "${RSC_BRAIN_PG_URL:-}" ] && [ -z "${CI:-}" ] && command -v postgres >/dev/null 2>&1; then
  eval "$(bash scripts/pg-test.sh env)"
fi
echo "▸ lint";      npx --no-install biome check .
echo "▸ typecheck"; npx --no-install tsc --noEmit
if [ -n "${RSC_BRAIN_PG_URL:-}" ]; then echo "▸ test (with PostgreSQL)"; else echo "▸ test (no PostgreSQL: those tests are skipped)"; fi
node --test --test-reporter=dot 'test/**/*.test.ts'
echo "▸ audit";     npm audit --omit=dev --audit-level=high
echo "✓ verify passed"
