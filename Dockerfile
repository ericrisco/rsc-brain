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

# AUDIT-064: the PRD scopes v1 as PDFs, and this image could not parse one — the layout/OCR backend
# is an operator extra kept deliberately OUT of the locked graph, because it pulls torch and would
# add gigabytes to every install including CPU-only boxes that never see a PDF. The consequence was
# a trap: install, drop a PDF, and get told to install something into a container you did not build.
#
# The extra stays opt-in and stays unlocked (`uv pip install`, not `uv sync`), so the lock keeps its
# property. What changes is that enabling it is a documented flag instead of a Dockerfile edit:
#   docker build --build-arg INSTALL_PDF_BACKEND=true .
ARG INSTALL_PDF_BACKEND=false
RUN --mount=type=cache,target=/root/.cache/uv \
    if [ "$INSTALL_PDF_BACKEND" = "true" ]; then \
        uv pip install --python /app/.venv/bin/python docling && \
        # AUDIT-067: docling pulls the full OpenCV wheel, whose `cv2` links against libxcb, libGL,
        # libgthread and libglib — measured with `ldd` inside the built image. Installing the Python
        # package alone produced a 9.48 GB PDF-capable image that still could not parse a PDF. The fix
        # is NOT to add X11 and OpenGL to a server image: the headless build provides the same `cv2`
        # with none of the GUI dependencies, which is both smaller and a narrower attack surface.
        # AUDIT-083: `--force-reinstall opencv-python-headless` left BOTH distributions installed.
        # Measured in the build image: opencv_python.libs still shipped 87 MB of libQt5Core/Gui/
        # Widgets/XcbQpa, libX11-xcb and a bundled OpenSSL 1.1.1k (2021, EOL) — the exact GUI stack
        # the AUDIT-067 comment claims to have avoided. Worse, `opencv-python` stayed a satisfied
        # requirement, so any later resolve could silently restore the GUI `.so` and break the
        # import again. Uninstall both, install the headless build alone, and fail the BUILD if the
        # GUI distribution is still present rather than discovering it on a host months later.
        uv pip uninstall --python /app/.venv/bin/python opencv-python opencv-python-headless || true; \
        uv pip install --python /app/.venv/bin/python opencv-python-headless && \
        test ! -d /app/.venv/lib/python3.12/site-packages/opencv_python.libs; \
    else \
        echo "PDF backend not installed (INSTALL_PDF_BACKEND=false); markdown/text ingestion only"; \
    fi

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
# AUDIT-070: docling's transformers engines call `torch.compile()` by default, and torch's inductor
# backend then shells out to a C++ compiler this image deliberately does not ship — so every PDF died
# with `InvalidCxxCompiler: ... (None, 'g++')` even once cv2 imported. Measured on the host with the
# same document: default → failure after 56s; eager mode → 112 characters extracted in 14s. Adding a
# toolchain to a production runtime to feed a JIT this workload never benefits from would be worse on
# both counts, so the image declares eager mode. `TORCHDYNAMO_DISABLE` is the legacy alias of the same
# switch (both measured working); the current name is set here.
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    TORCH_COMPILE_DISABLE=1
USER rsc

EXPOSE 8080
# Default role: the API + MCP (a single process). Overridden per service in the compose file.
CMD ["uvicorn", "rsc_brain.api.app:create_app", "--factory", \
     "--host", "0.0.0.0", "--port", "8080", "--proxy-headers"]
