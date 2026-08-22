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
6. Record the currently deployed version, so a rollback can name it:

   ```bash
   curl -fsS "https://<your-domain>/api/v1/version"
   ```

   The answer is the published version this instance runs, or that version with a `+dev` marker when
   the build is not a published release. It needs no credential and answers even when the database
   is unreachable. Inside the instance, `brain --version` reports the full build identity, which
   also distinguishes two different unpublished builds.

   Until 0.13.0 this step could not be performed: the image was always tagged `latest` and no
   interface reported a version, so an operator on `main` and an operator on the published release
   recorded the same string.

## If a version is withdrawn

A published version found defective or vulnerable is **marked withdrawn — never deleted**. Deleting
it would break every installation already pinned to it, which is the opposite of what a rollback
needs.

A withdrawn version:

- stops being recommended, and is not what you get by following the current instructions;
- carries a stated reason in its release notes;
- **remains installable** when you name it explicitly, so an installation pinned to it keeps
  starting and a rollback through it still works;
- is never removed from the registry.

If you are running one, upgrade past it. If you must stay on it briefly, you can — that is the point
of not deleting it.

## Upgrade a Compose deployment

Two paths, and both are supported.

**Installing a published version** (recommended, and much faster — no source build):

```bash
git checkout <version>-tag        # e.g. the tag whose images you are about to run
RSC_BRAIN_VERSION=<version> docker compose --env-file deploy/.env \
  -f deploy/docker-compose.version.yml \
  -f deploy/compose.models.yml \
  up -d
```

**Check out the matching tag first — this is the step a rollback gets wrong.** The compose file
supplies the environment the application expects, and that environment changes between versions. Run a
newer copy of the file against an older image and the API crash-loops on configuration it has never
heard of. Measured, pairing `main`'s copy with a published `0.13.1-rc2`:

```
capabilities.embedder.egress — Extra inputs are not permitted [type=extra_forbidden]
```

Nothing in that message says "your checkout is newer than your pin", so budget for the confusion if you
skip the checkout.

Rolling back is the same command with the previous version **and its tag**. Changing only
`RSC_BRAIN_VERSION` is the exact pairing above — a newer file against an older image — which is to say
the rollback would fail in the one situation you need it: mid-incident, under time pressure. Nothing is
rebuilt either way.

### Verify where an image came from, before you run it

Each published image carries a signed provenance statement naming the repository, the workflow, and
the commit that built it. Check it before an upgrade, and treat a failure as a reason to stop:

```bash
for component in app console db; do
  gh attestation verify "oci://ghcr.io/ericrisco/rsc-brain/${component}:<version>" \
    --repo ericrisco/rsc-brain
done
```

The data component is pinned by content rather than by release version, so use
`db:pg16-age-pgvector` in its place.

This answers a different question from the SBOM and the vulnerability scan published alongside each
release. Those describe what is inside an artifact; this says the artifact is the one this project's
CI built, rather than an image pushed by someone else to a similar name.

**Building from source** is unchanged and stays supported. The canonical Compose file builds
`rsc-brain/app:latest` from the checked-out source; it does not consume a release-tag variable. Check out the intended release, retain your protected environment
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

Update the pinned tag while preserving the release's existing values — using the chart from the
release whose images you are pinning:

```bash
git checkout <version>-tag        # the chart travels with the images it was reconciled against
helm upgrade rsc-brain deploy/helm/rsc-brain \
  --namespace rsc-brain \
  --reuse-values \
  --set image.tag=<version> \
  --wait \
  --wait-for-jobs
```

The chart declares this coupling itself: `Chart.yaml`'s `appVersion` names the rsc-brain release its
images ship with. Setting `image.tag` to something other than the chart's own `appVersion` runs a
configuration the older image may not accept — the chart's ConfigMap emits capability environment that
arrived in a specific version, and an image published before it refuses to start. Same failure as the
Compose path above, same cause.

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
