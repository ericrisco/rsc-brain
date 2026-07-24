#!/usr/bin/env bash
# Password guard (AUDIT-007): refuse to start with a blank, placeholder, or weak
# POSTGRES_PASSWORD, BEFORE Postgres initializes or listens. Supports Docker secrets
# via POSTGRES_PASSWORD_FILE. On success, hands off to the stock postgres entrypoint.
set -euo pipefail

password="${POSTGRES_PASSWORD:-}"
if [ -n "${POSTGRES_PASSWORD_FILE:-}" ] && [ -f "${POSTGRES_PASSWORD_FILE}" ]; then
    password="$(cat "${POSTGRES_PASSWORD_FILE}")"
fi

fail() {
    echo "FATAL(entrypoint-guard): $1" >&2
    exit 1
}

[ -n "${password}" ] || fail "POSTGRES_PASSWORD is not set. Provide a strong (>=16 char) password via env or POSTGRES_PASSWORD_FILE."

case "${password}" in
    CHANGE_ME* | change_me* | postgres | password | rsc_brain | example)
        fail "POSTGRES_PASSWORD is a known placeholder. Set a strong, unique password." ;;
esac

[ "${#password}" -ge 16 ] || fail "POSTGRES_PASSWORD is too short (<16 chars). Set a strong password."

exec docker-entrypoint.sh "$@"
