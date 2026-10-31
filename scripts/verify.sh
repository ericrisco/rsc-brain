#!/usr/bin/env bash
# Evidence gate: lint, types, build, tests, the web in a real browser, dependency audit. Exits non-zero on
# the first failure.
# Locally (not in CI) the tests also run against a real PostgreSQL: the one in RSC_BRAIN_PG_URL, or a
# throwaway local cluster when the server binaries are installed. CI runs without PostgreSQL: there the
# web is tested against the fixture API only, and the end-to-end tests say why they are skipped.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -z "${RSC_BRAIN_PG_URL:-}" ] && [ -z "${CI:-}" ] && command -v postgres >/dev/null 2>&1; then
  eval "$(bash scripts/pg-test.sh env)"
fi
echo "▸ lint";      npx --no-install biome check .
echo "▸ typecheck (server, web, browser tests)"
npx --no-install tsc --noEmit
npx --no-install tsc --noEmit -p web/tsconfig.json
npx --no-install tsc --noEmit -p tsconfig.browser.json
echo "▸ build (server and web)"; npm run --silent build >/dev/null
if [ -n "${RSC_BRAIN_PG_URL:-}" ]; then echo "▸ test (with PostgreSQL)"; else echo "▸ test (no PostgreSQL: those tests are skipped)"; fi
node --test --test-reporter=dot 'test/**/*.test.ts'
echo "▸ web (Playwright + axe, against the fixture API)"
rm -f test-results/measures.txt
npx --no-install playwright test -c playwright.config.ts --reporter=dot
# What the timing tests measured (the graph, CA5 and CA6), so a run's log keeps the numbers.
if [ -f test-results/measures.txt ]; then sed 's/^/  measured: /' test-results/measures.txt; fi
# The end-to-end tests need a PostgreSQL that answers; a result that did not run is reported as skipped.
pg_reachable() {
  node -e 'const pg=require("pg");const c=new pg.Client({connectionString:process.env.RSC_BRAIN_PG_URL,connectionTimeoutMillis:3000});c.connect().then(()=>c.end()).then(()=>process.exit(0),()=>process.exit(1))' 2>/dev/null
}
if [ -n "${CI:-}" ]; then
  echo "▸ e2e skipped: CI has no PostgreSQL (plan §5.1); run scripts/verify.sh locally with RSC_BRAIN_PG_URL"
elif [ -z "${RSC_BRAIN_PG_URL:-}" ]; then
  echo "▸ e2e skipped: RSC_BRAIN_PG_URL is not set and no local PostgreSQL was found"
elif ! pg_reachable; then
  echo "▸ e2e skipped: PostgreSQL at RSC_BRAIN_PG_URL does not answer"
else
  echo "▸ e2e (with PostgreSQL)"
  npx --no-install playwright test -c playwright.e2e.config.ts --reporter=dot
fi
echo "▸ audit";     npm audit --omit=dev --audit-level=high
echo "✓ verify passed"
