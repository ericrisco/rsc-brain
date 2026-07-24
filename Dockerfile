# syntax=docker/dockerfile:1
# rsc-brain application image (SPEC-18) — one image, several roles (api / worker / migrate / init),
# selected by the compose command. Multi-stage uv build; runs as a non-root user (12-factor).
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS build
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never
# Resolve dependencies first (cached) from the locked manifest, then install the project.
COPY pyproject.toml uv.lock README.md ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

FROM python:3.12-slim-bookworm AS runtime
# PostgreSQL 16 client (PGDG) so `brain backup`/`restore` match the server major version.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-16 \
    && apt-get purge -y --auto-remove curl gnupg \
    && rm -rf /var/lib/apt/lists/*

# Non-root runtime user.
RUN useradd --create-home --uid 10001 rsc
WORKDIR /app
COPY --from=build --chown=rsc:rsc /app /app
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1
USER rsc

EXPOSE 8080
# Default role: the API + MCP (a single process). Overridden per service in the compose file.
CMD ["uvicorn", "rsc_brain.api.app:create_app", "--factory", \
     "--host", "0.0.0.0", "--port", "8080", "--proxy-headers"]
