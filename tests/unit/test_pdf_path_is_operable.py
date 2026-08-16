"""AUDIT-067/068/069/070: the four defects that combine to make PDFs unusable.

Found by actually ingesting a PDF on a rented host, after the AUDIT-064 build flag shipped. Each is
survivable alone; together they are the worst possible sequence for an operator — submit a PDF, get
silence, fix the cause, and be told "duplicate".

AUDIT-068 and 069 paid for themselves immediately: they are what made AUDIT-070 *visible* instead of
another silent `error: null` on a document that could never be retried.
"""

from __future__ import annotations

import ast
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
    # Check for INSTALLATION, not mention: the AUDIT-083 comment names the GUI libraries it removed,
    # and a substring test over the whole file flagged that comment as if it were an apt line. A grep
    # that cannot tell prose from an instruction is the same weakness AUDIT-079 is about, inverted.
    instructions = "\n".join(
        line for line in dockerfile.splitlines() if not line.strip().startswith("#")
    ).lower()
    for gui_lib in ("libgl1", "libxcb1", "libx11"):
        assert gui_lib not in instructions, (
            f"{gui_lib} was added to a server image; the headless build removes the need for it"
        )
    assert "opencv_python.libs" in dockerfile, (
        "the build does not assert the GUI distribution is gone, so a later resolve can restore it"
    )


def test_the_pdf_image_does_not_need_a_cxx_compiler_at_runtime() -> None:
    """AUDIT-070: with `cv2` importable, docling still failed — its transformers engines call
    `torch.compile()` by default, and torch's inductor backend then shells out to a C++ compiler that
    a slim runtime image does not have (`InvalidCxxCompiler: ... (None, 'g++')`).

    Measured on the host, same PDF, three runs: default → failure after 56s; `TORCH_COMPILE_DISABLE=1`
    → 112 characters extracted in 14s. Shipping a C++ toolchain in a production image to enable a JIT
    that this workload does not benefit from would be strictly worse on both size and attack surface —
    so the image declares eager mode instead."""
    dockerfile = (REPO / "Dockerfile").read_text(encoding="utf-8")
    assert "TORCH_COMPILE_DISABLE=1" in dockerfile, (
        "docling's engines call torch.compile(), whose inductor backend needs g++ at runtime; without "
        "this the PDF backend builds fine and fails on every document"
    )
    for toolchain in ("build-essential", "g++", "gcc"):
        assert f"install -y --no-install-recommends {toolchain}" not in dockerfile, (
            f"{toolchain} was added to a runtime image to satisfy a JIT compiler; eager mode is "
            "faster here and carries no toolchain"
        )


def test_a_failed_ingestion_is_recorded_on_the_run() -> None:
    """AUDIT-068: the PDF failed before chunking, so the run stayed at `received` with `error: null`.
    The AUDIT-065 rule only fires when chunks exist and none produced claims, so it could not see a
    failure that happened earlier. Same class of defect, one stage upstream.

    Rewritten under AUDIT-088. This test used to assert `"AUDIT-068" in service` — a substring of a
    *comment*, which AUDIT-079 established proves nothing — and a bare function name that a rename
    silently invalidated. Worse, it read only `service.py`, so it stayed green through the entire
    period in which the queued path (the one every production install takes) recorded nothing at
    all. It now asserts the structure on **both** paths.
    """
    for module, function in (("service.py", "_admit_and_run"), ("queue.py", "_default_runner")):
        source = (REPO / "src" / "rsc_brain" / "ingest" / module).read_text(encoding="utf-8")
        tree = ast.parse(source)
        node = next(
            candidate
            for candidate in ast.walk(tree)
            if isinstance(candidate, (ast.FunctionDef, ast.AsyncFunctionDef))
            and candidate.name == function
        )
        handlers = [child for child in ast.walk(node) if isinstance(child, ast.ExceptHandler)]
        assert handlers, f"{module}:{function} does not handle a pipeline failure at all"

        called = {
            child.func.id
            for handler in handlers
            for child in ast.walk(handler)
            if isinstance(child, ast.Call) and isinstance(child.func, ast.Name)
        }
        assert "record_ingestion_failure" in called, (
            f"{module}:{function} catches the failure without writing it where `brain status` "
            "reads it — the operator sees a document that simply stopped"
        )
        assert any(
            isinstance(child, ast.Raise) and child.exc is None
            for handler in handlers
            for child in ast.walk(handler)
        ), f"{module}:{function} swallows the exception instead of re-raising it"


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
    # NOT `"status" in head`: the BUGGY code read `IngestOutcome(existing.id, existing.status, ...)`,
    # so that assertion passed on the very defect it was written to catch — reproduced by review.
    assert "existing.status !=" in head, (
        "the checksum short-circuit does not compare the existing document's status, so a failed "
        "document is still indistinguishable from a processed one"
    )
