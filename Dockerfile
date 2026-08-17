# syntax=docker/dockerfile:1
# rsc-brain application image (SPEC-18) — one image, several roles (api / worker / migrate / init),
# selected by the compose command. Multi-stage uv build; runs as a non-root user (12-factor).
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS build
WORKDIR /app

# SPEC release-identity: the artifact carries the identity it will report, fixed here because the
# artifact IS the thing being identified. The value is what `git describe --tags --always --dirty`
# yields for the source this image was built from.
#
# The build FAILS on an empty value rather than producing an image that quietly reports "not a
# published release" while being one. That is the AUDIT-083 rule — assert the property where it is
# created, not months later on an operator's host — and it matters more here than usual, because an
# unstamped image does not crash: it lies quietly, and only in the direction of understatement.
#
# Placed FIRST on purpose. Sitting at the end of the build stage it would still be correct and would
# still fail — after the twenty-five minutes the PDF backend takes. A guard that only reports at the
# end of the expensive work teaches people to skip it.
ARG RSC_BRAIN_BUILD_IDENTITY
RUN test -n "${RSC_BRAIN_BUILD_IDENTITY}" \
    || { echo "build identity is empty: pass --build-arg RSC_BRAIN_BUILD_IDENTITY=\$(git describe --tags --always --dirty)" >&2; exit 1; }

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
        # AUDIT-095: docling depends on torch, and torch's default wheel on PyPI for linux is the
        # CUDA build. It drags the whole NVIDIA runtime in as hard dependencies. Measured inside the
        # published 0.13.1-rc2 image: nvidia 2724 MB, torch 1127 MB (2.13.0+cu130), triton 691 MB —
        # 4.5 GB of a 5.9 GB filesystem, in a product that runs no model locally. Inference is
        # remote through litellm, and OCR runs on onnxruntime since AUDIT-087. Not one of those
        # bytes ever executes; they are downloaded, stored, backed up and scanned for CVEs forever.
        #
        # Install the CPU build FIRST, from PyTorch's own CPU index, so docling's resolve finds its
        # torch requirement already satisfied and never reaches for the CUDA wheel. Ordering is the
        # mechanism: replacing torch afterwards would leave the nvidia packages behind as orphans,
        # still installed and still counted.
        uv pip install --python /app/.venv/bin/python \
            --index-url https://download.pytorch.org/whl/cpu torch torchvision && \
        uv pip install --python /app/.venv/bin/python docling && \
        # Assert it here, in the build, rather than discovering on an operator's host that the image
        # grew by four gigabytes again — the AUDIT-083 rule. A later docling release that tightens
        # its torch pin can silently pull the CUDA wheel back in; this is what stops it shipping.
        test ! -d /app/.venv/lib/python3.12/site-packages/nvidia && \
        test ! -d /app/.venv/lib/python3.12/site-packages/triton && \
        /app/.venv/bin/python -c "import torch, sys; sys.exit('CUDA build reinstalled: ' + torch.__version__) if 'cu' in torch.__version__.split('+')[-1] else None" && \
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
        test ! -d /app/.venv/lib/python3.12/site-packages/opencv_python.libs && \
        # AUDIT-087: the rapidocr wheel ships PP-OCRv6 as `.onnx`, and rapidocr's own default engine
        # is `onnxruntime` — but the runtime that executes those files was never installed. So the
        # engine fell back to torch and fetched a PARALLEL set of `.pth` weights from huggingface.co,
        # unauthenticated, on the first scanned page. Measured on a real host: 3 `.onnx` at build
        # time, 7 files and 62 MB after one PDF. An install with restricted egress therefore passed
        # the build, passed `brain verify`, accepted the upload with 202, and only then failed —
        # while `deploy/README.md` says building the image once is enough.
        #
        # Install the runtime for the models already in the image, and fail the BUILD if it cannot
        # import, rather than discovering it on an operator's air-gapped host (the AUDIT-083 rule:
        # assert the property here, not months later).
        uv pip install --python /app/.venv/bin/python onnxruntime && \
        /app/.venv/bin/python -c "import onnxruntime" && \
        # Half a fix is still a network dependency. The wheel bundles only the CHINESE PP-OCRv6
        # models, so asking for `latin` — the model that reads Spanish, which is the product's
        # declared scope — fetched two more `.onnx` on the first scanned page even with the engine
        # pinned. Measured: 4 downloads before, 2 after; the right language, still over the wire.
        # Warm the models this product actually asks for into the image, then assert they are on
        # disk. An air-gapped install must not discover its OCR models are elsewhere.
        /app/.venv/bin/python -c "\
from rapidocr import RapidOCR, EngineType, LangDet, LangRec, ModelType, OCRVersion; \
RapidOCR(params={'Det.engine_type': EngineType.ONNXRUNTIME, 'Det.lang_type': LangDet.CH, 'Det.model_type': ModelType.MOBILE, 'Det.ocr_version': OCRVersion.PPOCRV5, 'Rec.engine_type': EngineType.ONNXRUNTIME, 'Rec.lang_type': LangRec.LATIN, 'Rec.model_type': ModelType.MOBILE, 'Rec.ocr_version': OCRVersion.PPOCRV5})" && \
        ls /app/.venv/lib/python3.12/site-packages/rapidocr/models/ | grep -q "latin_PP-OCRv5_rec" ; \
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
# Re-declared: a multi-stage build drops build arguments between stages, so an identity that
# existed only in the build stage would be an identity the running process cannot read.
ARG RSC_BRAIN_BUILD_IDENTITY
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    TORCH_COMPILE_DISABLE=1 \
    RSC_BRAIN_BUILD_IDENTITY=${RSC_BRAIN_BUILD_IDENTITY}
USER rsc

EXPOSE 8080
# Default role: the API + MCP (a single process). Overridden per service in the compose file.
CMD ["uvicorn", "rsc_brain.api.app:create_app", "--factory", \
     "--host", "0.0.0.0", "--port", "8080", "--proxy-headers"]
