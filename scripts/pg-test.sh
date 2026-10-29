#!/usr/bin/env bash
# A throwaway local PostgreSQL for the tests: one cluster in .pg-test/, trust auth, localhost only.
#   pg-test.sh start   start it (initialising on first use)
#   pg-test.sh stop    stop it
#   pg-test.sh env     start it and print `export RSC_BRAIN_PG_URL=…` for eval
# RSC_BRAIN_PG_DIR moves the cluster elsewhere (e.g. one shared by several worktrees).
# PG_BIN picks the server binaries (default: the directory of `postgres` on PATH).
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${RSC_BRAIN_PG_DIR:-$PWD/.pg-test}"
PORT="${RSC_BRAIN_PG_PORT:-55432}"
PG_BIN="${PG_BIN:-$(dirname "$(readlink -f "$(command -v postgres)")")}"
URL="postgres://brain_admin@localhost:${PORT}/postgres"

start() {
  export LC_ALL="${LC_ALL:-C}"   # macOS: postgres refuses to start without a valid locale
  if [ ! -f "$DIR/data/PG_VERSION" ]; then
    mkdir -p "$DIR"
    "$PG_BIN/initdb" -D "$DIR/data" -U brain_admin --auth=trust --encoding=UTF8 --locale=C >"$DIR/initdb.log"
  fi
  if ! "$PG_BIN/pg_ctl" -D "$DIR/data" status >/dev/null 2>&1; then
    "$PG_BIN/pg_ctl" -D "$DIR/data" -l "$DIR/server.log" -w \
      -o "-p $PORT -c listen_addresses=localhost -c unix_socket_directories= -c fsync=off" start >/dev/null
  fi
}

case "${1:-}" in
  start) start; echo "$URL" ;;
  stop) "$PG_BIN/pg_ctl" -D "$DIR/data" -w stop >/dev/null 2>&1 || true ;;
  env) start; echo "export RSC_BRAIN_PG_URL=$URL" ;;
  *) echo "usage: $0 start|stop|env" >&2; exit 2 ;;
esac
