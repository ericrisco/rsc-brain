# Upgrade an instance
<!-- diataxis: how-to -->

Upgrade one release at a time when release notes call out data or configuration changes. Pin the
source release or supply a registry overlay with immutable image tags.

## Before the upgrade

1. Read every intervening section in the [changelog](../../CHANGELOG.md).
2. Compare your environment with the [configuration reference](../reference/configuration.md).
3. Run the read-only tenant-integrity check inside the currently deployed API container. For
   Compose, use the same complete file set as the installation:

   ```bash
   docker compose --env-file deploy/.env \
     -f deploy/docker-compose.prod.yml \
     -f deploy/compose.models.yml \
     exec api brain preflight --json
   ```

   For Helm:

   ```bash
   kubectl -n rsc-brain exec deploy/rsc-brain-api -- brain preflight --json
   ```

4. Resolve every reported cross-project violation before migration.
5. Create and retain a verified [backup](backup-and-restore.md).
6. Record the currently deployed application tag and configuration revision for rollback.

## Upgrade a Compose deployment

The canonical Compose file builds `rsc-brain/app:latest` from the checked-out source; it does not
consume a release-tag variable. Check out the intended release, retain your protected environment
and model overlay, then rebuild with the same complete file set used for installation:

```bash
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml \
  -f deploy/compose.models.yml \
  up -d --build
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml \
  -f deploy/compose.models.yml \
  ps
```

The one-shot `migrate` service runs `brain init`; `api` and `worker` wait for it to complete. Inspect
its status without expecting credentials in lifecycle logs:

```bash
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml \
  -f deploy/compose.models.yml \
  logs migrate
```

## Upgrade a Helm deployment

Update the pinned tag while preserving the release's existing values:

```bash
helm upgrade rsc-brain deploy/helm/rsc-brain \
  --namespace rsc-brain \
  --reuse-values \
  --set image.tag=0.13.0 \
  --wait \
  --wait-for-jobs
```

The migration Job is an ordinary Helm resource named for the release revision, not a pre-upgrade
hook. `--wait-for-jobs` waits for that Job, while API and worker init containers independently wait
for the schema to reach head. The Job must complete and the application pods must become ready
before the command succeeds.

## Verify service behavior

Run the packaged readiness check inside the new application image. For Compose, reuse every overlay:

```bash
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml \
  -f deploy/compose.models.yml \
  exec api brain verify --json
```

For Helm, run `kubectl -n rsc-brain exec deploy/rsc-brain-api -- brain verify --json`. Readiness
confirms complete capability configuration, database extensions, and the exact schema head. It does
not contact model providers, process a document, or prove recall. Follow it with an authorized
provider check and an ingest-to-recall smoke test for your environment.

## Roll back

Do not assume an older binary can run against a newer schema. If the release does not document a
compatible binary rollback, first create an inactive target with empty writable storage, the previous
pinned image, and the previous configuration. Run that previous version's `brain restore` against the
pre-upgrade snapshot, verify the inactive target, and switch traffic only after validation.

This order is required because `brain restore` applies migrations to the schema head known by the
CLI binary that runs it. Restoring with the newer image and replacing it with the older image can
leave the older binary pointed at the newer schema.

The migration system does not perform automatic schema downgrades.
