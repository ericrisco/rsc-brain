"""AUDIT-064: the product's flagship input format must be reachable without rebuilding by hand."""

from __future__ import annotations

from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[2]


def test_the_image_can_be_built_with_the_pdf_backend() -> None:
    """The PRD scopes v1 as PDFs, and the production image could not parse one: the layout/OCR
    backend is an operator extra, deliberately outside the locked graph because it pulls torch. So
    an operator installed, dropped a PDF, and got an error telling them to install something — into
    a container, which means rebuilding an image they did not build.

    The extra stays opt-in (the lock stays clean, a CPU-only box is not forced to carry gigabytes of
    weights), but enabling it must be a documented flag rather than a Dockerfile edit."""
    dockerfile = (REPO / "Dockerfile").read_text(encoding="utf-8")
    assert "INSTALL_PDF_BACKEND" in dockerfile, (
        "no build argument enables the PDF backend, so the flagship format needs a hand-edited image"
    )
    assert "docling" in dockerfile, "the argument must actually install the layout/OCR backend"


def test_the_production_compose_exposes_the_flag() -> None:
    """A build argument nobody can reach from the documented deploy path is not a fix."""
    spec = yaml.safe_load((REPO / "deploy" / "docker-compose.prod.yml").read_text(encoding="utf-8"))
    migrate = spec["services"]["migrate"]
    args = (migrate.get("build") or {}).get("args") or {}
    assert any("INSTALL_PDF_BACKEND" in str(k) for k in args), (
        "the shared application image is built by the `migrate` service; the flag must be settable "
        "there or no deploy-path operator can turn it on"
    )


def test_the_limitation_is_documented_where_an_operator_looks() -> None:
    readme = (REPO / "deploy" / "README.md").read_text(encoding="utf-8")
    assert "INSTALL_PDF_BACKEND" in readme, "deploy/README.md must say how to enable PDF parsing"
