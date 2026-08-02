# Back up and restore an instance
<!-- diataxis: how-to -->

`brain backup` captures the PostgreSQL database and stored source-document blobs. It writes a
snapshot directory with a manifest containing component sizes and SHA-256 digests. Configuration,
provider credentials, deployment secrets, and container images are not part of the snapshot.

Quiesce uploads and let the worker finish before taking a release backup. Use a new snapshot path and
retain the directory structure when moving it to protected storage. The command needs `pg_dump` on
`PATH` and read access to the configured data directory; the application image includes the
PostgreSQL 16 client tools.

## Back up a source-checkout instance

Run from the checkout that owns the instance. The DSN must use a hostname reachable from the host,
and the data path must name the host directory that contains `blobs/`:

```bash
export RSC_BRAIN_DATABASE__DSN="postgresql+asyncpg://rsc_brain:password@127.0.0.1:5432/rsc_brain"
export RSC_BRAIN_INGEST__DATA_DIR="$PWD/data"
uv run brain backup --output "$PWD/backups/rsc-brain-2026-08-02"
```

Do not use the Compose-only hostname `db` or a container path in this recipe. The development
database publishes port `5432`; the production Compose database does not.

## Back up a Compose instance

Run inside the API container, where `db` resolves and the `app_data` volume is mounted. Repeat the
same environment file and every Compose overlay used by the deployed instance on each command. This
example uses the canonical file and the model overlay:

```bash
mkdir -p ./backups
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml \
  -f deploy/compose.models.yml \
  exec api brain backup \
  --output /var/lib/rsc-brain/data/operator-backups/rsc-brain-2026-08-02
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml \
  -f deploy/compose.models.yml \
  cp api:/var/lib/rsc-brain/data/operator-backups/rsc-brain-2026-08-02 \
  ./backups/rsc-brain-2026-08-02
```

The snapshot is first written outside `blobs/` on `app_data`, then exported to the host. The runtime
image does not include `uv`, `/srv/backups` is not mounted, and the database port is not published;
host-side versions of this command do not have the required execution context. Confirm the exported
directory contains `manifest.json` and `database.dump` before moving it off the host.

## Back up a Helm instance

Run `brain` directly in the API pod, then copy the snapshot from the application-data PVC. Select the
pod for the intended release rather than another API pod in the namespace:

```bash
mkdir -p ./backups
export RSC_BRAIN_API_POD="$(kubectl -n rsc-brain get pods \
  -l 'app.kubernetes.io/instance=rsc-brain,app.kubernetes.io/component=api' \
  -o jsonpath='{.items[0].metadata.name}')"
kubectl -n rsc-brain exec "$RSC_BRAIN_API_POD" -- \
  brain backup --output /var/lib/rsc-brain/data/operator-backups/rsc-brain-2026-08-02
kubectl -n rsc-brain cp \
  "$RSC_BRAIN_API_POD:/var/lib/rsc-brain/data/operator-backups/rsc-brain-2026-08-02" \
  ./backups/rsc-brain-2026-08-02
```

The application-data PVC must already be writable by Helm's configured UID. A bound claim and a
successful chart render do not prove this write path.

## Prepare an inactive restore target

Restore is destructive to the selected database. It uses clean replacement semantics for database
objects, then merges restored blobs into the target `blobs/` directory without removing files absent
from the snapshot. Use a new or empty database and a new, empty, writable data directory or PVC.
Keep API traffic disabled and stop every worker that could write to the target.

Choose the target application version before restoring. `brain restore` always applies migrations to
the schema head known by the CLI binary that executes it. For an upgrade rollback, create the inactive
target with the previous pinned image and configuration, then run that previous version's CLI. Do not
restore with a newer CLI and replace it afterward with an older image.

Restore verifies the manifest, sizes, and SHA-256 hashes before it changes the database. It then runs
`pg_restore`, migrates to that CLI version's head, verifies AGE, pgvector, and the exact schema head,
and copies blobs only after the database passes. A verified snapshot still does not include the
target's configuration or secrets.

## Restore a source-checkout target

Run from the checkout for the target version. Set a host-resolvable replacement DSN and a host path
that is empty and writable:

```bash
export RSC_BRAIN_DATABASE__DSN="postgresql+asyncpg://rsc_brain:password@127.0.0.1:5433/rsc_brain"
export RSC_BRAIN_INGEST__DATA_DIR="$PWD/restore-data"
uv run brain restore "$PWD/backups/rsc-brain-2026-08-02"
uv run brain verify --json
```

## Restore a Compose target

Build or pull the intended application version and configure the inactive target first. Start its
empty database, create a stopped API service container so `docker compose cp` can reach `app_data`,
copy the snapshot into that volume, and run restore from a one-shot container. The API, worker, and
edge must remain stopped:

```bash
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml \
  -f deploy/compose.models.yml \
  up -d --wait db
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml \
  -f deploy/compose.models.yml \
  run --rm --no-deps api \
  mkdir -p /var/lib/rsc-brain/data/operator-restores
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml \
  -f deploy/compose.models.yml \
  create api
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml \
  -f deploy/compose.models.yml \
  cp ./backups/rsc-brain-2026-08-02 \
  api:/var/lib/rsc-brain/data/operator-restores/rsc-brain-2026-08-02
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml \
  -f deploy/compose.models.yml \
  run --rm --no-deps api brain restore \
  /var/lib/rsc-brain/data/operator-restores/rsc-brain-2026-08-02
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml \
  -f deploy/compose.models.yml \
  run --rm --no-deps api brain verify --json
```

Replace the file set above with the exact Coolify, Dokploy, or private overlays used by the target.
The database must be reachable as configured in that merged environment.

## Restore a Helm target

Install the inactive target with the intended image/configuration, empty writable PVCs, and no public
Ingress. Record the intended worker replica count, scale its Deployment to zero, and retain one API
pod for the restore command. Copy the snapshot into that pod's application-data PVC, then run `brain`
directly:

```bash
export RSC_BRAIN_API_POD="$(kubectl -n rsc-brain get pods \
  -l 'app.kubernetes.io/instance=rsc-brain,app.kubernetes.io/component=api' \
  -o jsonpath='{.items[0].metadata.name}')"
kubectl -n rsc-brain scale deploy/rsc-brain-worker --replicas=0
kubectl -n rsc-brain rollout status deploy/rsc-brain-worker --timeout=2m
kubectl -n rsc-brain exec "$RSC_BRAIN_API_POD" -- \
  mkdir -p /var/lib/rsc-brain/data/operator-restores
kubectl -n rsc-brain cp ./backups/rsc-brain-2026-08-02 \
  "$RSC_BRAIN_API_POD:/var/lib/rsc-brain/data/operator-restores/rsc-brain-2026-08-02"
kubectl -n rsc-brain exec "$RSC_BRAIN_API_POD" -- \
  brain restore /var/lib/rsc-brain/data/operator-restores/rsc-brain-2026-08-02
kubectl -n rsc-brain exec "$RSC_BRAIN_API_POD" -- brain verify --json
```

## Activate the restored target

After restore and verification:

1. confirm the target uses the selected version's protected configuration and secrets;
2. run a provider-reachability check from the API and worker network contexts;
3. start or rescale the worker and API roles, restoring any recorded replica counts;
4. perform an authorized recall check against a known document; and
5. switch traffic only after those checks pass.

Read [Upgrade an instance](upgrade.md) before combining a restore with a version change.
