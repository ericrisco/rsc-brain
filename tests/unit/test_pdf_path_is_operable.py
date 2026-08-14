"""AUDIT-067/068/069: the three defects that combine to make PDFs unusable.

Found by actually ingesting a PDF on a rented host, after the AUDIT-064 build flag shipped. Each is
survivable alone; together they are the worst possible sequence for an operator — submit a PDF, get
silence, fix the cause, and be told "duplicate".
"""

from __future__ import annotations

from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def test_the_pdf_image_does_not_need_a_gui_stack() -> None:
    """AUDIT-067: the flag installed the Python package and stopped there. `cv2` links against
    libxcb, libGL, libgthread and libglib — measured with `ldd` inside the built image — so a 9.48 GB
    PDF-capable image still could not parse a PDF.

    A server image must not carry X11 and OpenGL to satisfy one import. The headless OpenCV build
    exists for exactly this, and is both smaller and a narrower attack surface than the GUI stack."""
    dockerfile = (REPO / "Dockerfile").read_text(encoding="utf-8")
    assert "opencv-python-headless" in dockerfile, (
        "cv2 needs a GUI stack unless the headless build is used; installing docling alone leaves an "
        "image that cannot parse a PDF"
    )
    for gui_lib in ("libgl1", "libxcb1", "libx11"):
        assert gui_lib not in dockerfile.lower(), (
            f"{gui_lib} was added to a server image; the headless build removes the need for it"
        )


def test_a_failed_ingestion_is_recorded_on_the_run() -> None:
    """AUDIT-068: the PDF failed before chunking, so the run stayed at `received` with `error: null`.
    The AUDIT-065 rule only fires when chunks exist and none produced claims, so it could not see a
    failure that happened earlier. Same class of defect, one stage upstream."""
    service = (REPO / "src" / "rsc_brain" / "ingest" / "service.py").read_text(encoding="utf-8")
    assert "AUDIT-068" in service, "a pipeline failure is not recorded against the run"
    assert "record_failure" in service or "run_error" in service, (
        "the failure must be written where `brain status` reads it, not only to stderr"
    )


def test_a_document_stuck_before_processing_can_be_retried() -> None:
    """AUDIT-069, the nastiest of the three. Deduplication short-circuited on checksum WITHOUT
    looking at the existing document's status, so a document whose parse had failed was
    indistinguishable from one fully processed. An operator who fixed the cause and re-submitted was
    told `duplicate: true` and the document stayed at `received` forever, with no route back.

    Dedup is right for an ingestion that got somewhere. Applied to one that never started, it traps
    the document."""
    service = (REPO / "src" / "rsc_brain" / "ingest" / "service.py").read_text(encoding="utf-8")
    assert "AUDIT-069" in service, "the dedup short-circuit still ignores the existing status"
    head = service[service.index("checksum = hashlib") : service.index("source_row = await")]
    assert "status" in head, (
        "the checksum short-circuit must consider whether the existing document ever progressed"
    )
