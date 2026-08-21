# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# rsc-brain data service: Postgres 16 + Apache AGE + pgvector, in one image.
#
# Reproducibility & supply chain (AUDIT-007):
#   * base image is pinned by immutable digest (apache/age release_PG16_1.6.0);
#   * pgvector is built from a pinned tag AND its commit SHA is verified before build;
#   * OPTFLAGS="" avoids -march=native so the build is portable across host CPUs.
# The runtime identity is the base image's `postgres` user (uid/gid 999) from PID 1 onward.
# The inherited gosu helper is removed because this image never starts as root.
# ---------------------------------------------------------------------------
FROM apache/age@sha256:16aa423d20a31aed36a3313244bf7aa00731325862f20ed584510e381f2feaed

ARG PGVECTOR_TAG=v0.8.5
ARG PGVECTOR_SHA=159b79aaad5983fb7459c1e3df2897fbb2d11788

# Refresh fixed distribution packages, build pgvector from verified source, remove the inherited
# root-to-user helper, then remove the complete build toolchain.
RUN set -eux; \
    apt-get update; \
    apt-get upgrade -y; \
    apt-get install -y --no-install-recommends build-essential curl git ca-certificates postgresql-server-dev-16; \
    git clone --depth 1 --branch "${PGVECTOR_TAG}" https://github.com/pgvector/pgvector.git /tmp/pgvector; \
    cd /tmp/pgvector; \
    test "$(git rev-parse HEAD)" = "${PGVECTOR_SHA}"; \
    make OPTFLAGS=""; \
    make install; \
    cd /; \
    rm -rf /tmp/pgvector; \
    rm -f /usr/local/bin/gosu; \
    apt-get purge -y --auto-remove \
        build-essential curl git postgresql-server-dev-16 \
        dirmngr gnupg gnupg-l10n gpg gpg-agent gpgconf gpgsm; \
    rm -rf /var/lib/apt/lists/*

# Enable AGE + pgvector on first initialization of the application database.
COPY docker/initdb/10-extensions.sql /docker-entrypoint-initdb.d/10-extensions.sql
# Refuse to start with a blank/placeholder/weak POSTGRES_PASSWORD before Postgres listens.
COPY docker/entrypoint-guard.sh /usr/local/bin/entrypoint-guard.sh
RUN chmod +x /usr/local/bin/entrypoint-guard.sh

USER 999:999

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=5 \
    CMD pg_isready -U "${POSTGRES_USER:-rsc_brain}" -d "${POSTGRES_DB:-rsc_brain}" || exit 1

ENTRYPOINT ["entrypoint-guard.sh"]
CMD ["postgres", "-c", "shared_preload_libraries=age"]
