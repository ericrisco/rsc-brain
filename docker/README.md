# Data service image — Postgres 16 + Apache AGE + pgvector

[`db.Dockerfile`](db.Dockerfile) builds the single data service the whole product runs on.

## Security posture (AUDIT-007)

- **Immutable inputs.** The base image is pinned by digest
  (`apache/age@sha256:16aa423d…`); pgvector is built from tag `v0.8.5` and its commit SHA
  (`159b79aa…`) is verified before compiling. `OPTFLAGS=""` keeps the build portable across
  host CPUs. The build toolchain is purged from the final image.
- **Local-only by default.** [`../docker-compose.yml`](../docker-compose.yml) binds every
  published port to `127.0.0.1` unless a `*_BIND` variable is deliberately changed.
- **No weak credentials.** `POSTGRES_PASSWORD` is required by Compose and re-validated by
  [`entrypoint-guard.sh`](entrypoint-guard.sh) — blank, known-placeholder, or `<16`-char
  passwords are refused **before** Postgres listens. Docker secrets (`POSTGRES_PASSWORD_FILE`)
  are supported.
- **Healthcheck.** `pg_isready` gates readiness; Compose `up --wait` blocks until healthy.

## Least-privilege assertion (verified)

| Property | Value | Evidence |
|---|---|---|
| Effective runtime identity | `postgres` (uid **999**), not root | `docker top` shows PID 1 `postgres` owned by uid 999 |
| Privilege escalation | disabled | Compose `security_opt: no-new-privileges:true` |
| Writable state | only the `db_data` volume at `/var/lib/postgresql/data` | rest of the rootfs is not written at runtime |
| Extensions load | AGE `1.6.0`, pgvector `0.8.5` | `SELECT extname, extversion FROM pg_extension` in the boot smoke test |

The base postgres entrypoint starts as root **only** to fix data-dir ownership, then drops to
`postgres` via gosu; that dropped uid is the effective runtime identity (this is why a generic
`USER` directive is intentionally **not** applied — it would break ownership fixing). `docker
exec` defaults to root and is not representative of the server process; use `-u postgres`.

## Smoke test

```bash
export POSTGRES_PASSWORD="$(openssl rand -base64 24)"
docker compose up -d --wait db
docker compose exec -u postgres -T db \
  psql -U rsc_brain -d rsc_brain -c "SELECT extname, extversion FROM pg_extension;"
docker compose down -v
```
