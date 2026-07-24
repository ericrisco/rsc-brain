# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# rsc-brain data service: Postgres 16 + Apache AGE + pgvector, in one image.
#
# Reproducibility & supply chain (AUDIT-007):
#   * base image is pinned by immutable digest (apache/age release_PG16_1.6.0);
#   * pgvector is built from a pinned tag AND its commit SHA is verified before build;
#   * OPTFLAGS="" avoids -march=native so the build is portable across host CPUs.
# The runtime identity is the base image's `postgres` user: the postgres entrypoint starts
# as root only to fix data-dir ownership, then drops to `postgres` (uid 999) via gosu. That
# dropped uid is the effective, least-privilege runtime identity (documented for Trivy DS002).
# ---------------------------------------------------------------------------
FROM apache/age@sha256:4241e2d8bb86a6b2ea44e9ad06c73856e12b209de295124603a599dd7feb70eb

ARG PGVECTOR_TAG=v0.8.5
ARG PGVECTOR_SHA=159b79aaad5983fb7459c1e3df2897fbb2d11788

# Build pgvector from verified source, then remove the build toolchain again.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends build-essential git ca-certificates postgresql-server-dev-16; \
    git clone --depth 1 --branch "${PGVECTOR_TAG}" https://github.com/pgvector/pgvector.git /tmp/pgvector; \
    cd /tmp/pgvector; \
    test "$(git rev-parse HEAD)" = "${PGVECTOR_SHA}"; \
    make OPTFLAGS=""; \
    make install; \
    cd /; \
    rm -rf /tmp/pgvector; \
    apt-get purge -y --auto-remove build-essential git postgresql-server-dev-16; \
    rm -rf /var/lib/apt/lists/*

# Enable AGE + pgvector on first initialization of the application database.
COPY docker/initdb/10-extensions.sql /docker-entrypoint-initdb.d/10-extensions.sql
# Refuse to start with a blank/placeholder/weak POSTGRES_PASSWORD before Postgres listens.
COPY docker/entrypoint-guard.sh /usr/local/bin/entrypoint-guard.sh
RUN chmod +x /usr/local/bin/entrypoint-guard.sh

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=5 \
    CMD pg_isready -U "${POSTGRES_USER:-rsc_brain}" -d "${POSTGRES_DB:-rsc_brain}" || exit 1

ENTRYPOINT ["entrypoint-guard.sh"]
CMD ["postgres", "-c", "shared_preload_libraries=age"]
