# Data service image — Postgres 16 + Apache AGE + pgvector

[`db.Dockerfile`](db.Dockerfile) builds the single data service the whole product runs on.

## Security posture (AUDIT-007)

- **Immutable inputs.** Every prebuilt development image retains a readable version tag and is
  pinned by manifest digest. The database base image is pinned by digest
  (`apache/age@sha256:16aa423d…`); pgvector is built from tag `v0.8.5` and its commit SHA
  (`159b79aa…`) is verified before compiling. Fixed distribution packages are applied during the
  image build. `OPTFLAGS=""` keeps the build portable across host CPUs. The inherited `gosu`
  privilege-drop helper and the complete build toolchain are removed from the final image.
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
| Effective runtime identity | `postgres` (uid/gid **999**) from PID 1, never root | Docker image `USER`, Compose `user`, and `/proc/1/status` agree |
| Privilege escalation | disabled | Compose `security_opt: no-new-privileges:true` |
| Capability bound | empty (effective, permitted, and bounding sets are all zero) | Compose drops `ALL` without adding any capability; the runtime test reads `/proc/1/status` |
| Writable state | `db_data` plus bounded `noexec,nosuid,nodev` tmpfs for `/tmp` and the Postgres socket | Compose sets `read_only: true`; Docker inspection verifies exact mounts |
| Extensions load | AGE `1.6.0`, pgvector `0.8.5` | `SELECT extname, extversion FROM pg_extension` in the boot smoke test |

The image and Compose both select uid/gid 999, so the entrypoint never takes its root-only ownership
branch. Docker's fresh named-volume copy-up preserves the image data-directory ownership; the real
blank-volume boot test proves initialization succeeds without `gosu` or elevated capabilities.

## Vulnerability gate

The gate uses an immutable Trivy 0.66.0 image and fails on every new, changed, stale, or fixable
high/critical package result. The only accepted entries are the exact no-fix findings with a
reachability rationale in [`trivy-db-unfixed-baseline.json`](trivy-db-unfixed-baseline.json):

```bash
python scripts/check_dev_container_vulnerabilities.py
```

This is a reviewed exception inventory, not `--ignore-unfixed`: findings remain visible and the gate
requires re-triage as soon as Trivy reports a fixed version or a changed package/advisory. Every
entry has an owner and review deadline; an expired entry fails the same gate.

## Smoke test

```bash
export POSTGRES_PASSWORD="$(openssl rand -base64 24)"
docker compose up -d --wait db
docker compose exec -u postgres -T db \
  psql -U rsc_brain -d rsc_brain -c "SELECT extname, extversion FROM pg_extension;"
docker compose down -v
```
