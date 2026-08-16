"""AUDIT-090: `scanned` was always False and `ocr_confidence` always None — for every document.

FR-1.3 (native-vs-scanned detection) and FR-1.4 (OCR-confidence propagation) were read from
`page.cells[*].from_ocr`. Docling's page model has **no `cells` attribute at all** — dumping it on
a real host gives one real field, `image`, and pydantic's methods. So `getattr(page, "cells", [])`
returned the empty default on every page of every document ever ingested, and both requirements
answered "nothing happened" every time.

Two things hid it. The function carried `# pragma: no cover`, so coverage never complained. And
`MarkdownParser` stamps `scanned` from a constructor flag — its docstring says the propagation path
"is exercised without a live OCR engine" — so the tests proved the *propagation* while nothing
proved the *detection*.

It surfaced only after AUDIT-087 made OCR work at all: a rasterised, text-layer-free PDF came back
with three OCR'd prose blocks (`"GLOBEXIBERIA"`, `"20 26"` — the spacing artefacts are the
giveaway) and `scanned=False`.

The replacement discriminator was found by converting both kinds of document and comparing, rather
than by guessing at an API:

    07-scanned.pdf   (image only)   parse_score=nan   ocr_score=0.9459
    05-native.pdf    (text layer)   parse_score=1.0   ocr_score=nan
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from rsc_brain.ingest.parser import ocr_provenance


@dataclass
class _Page:
    ocr_score: float


@dataclass
class _Confidence:
    pages: dict[int, _Page]


@dataclass
class _Result:
    confidence: _Confidence | None


def test_a_scanned_page_is_detected_with_its_confidence() -> None:
    """The measured shape of a rasterised PDF."""
    scanned, confidence = ocr_provenance(_Result(_Confidence({1: _Page(0.9458740000000001)})))
    assert scanned is True
    assert confidence is not None
    assert abs(confidence - 0.945874) < 1e-6


def test_a_native_page_is_not_scanned() -> None:
    """The measured shape of a PDF with a text layer: `ocr_score` is nan, not absent."""
    scanned, confidence = ocr_provenance(_Result(_Confidence({1: _Page(math.nan)})))
    assert scanned is False
    assert confidence is None


def test_a_mixed_document_averages_only_the_ocred_pages() -> None:
    """A scan bound in with native pages must not have its confidence diluted by the native ones."""
    result = _Result(_Confidence({1: _Page(math.nan), 2: _Page(0.8), 3: _Page(0.6)}))
    scanned, confidence = ocr_provenance(result)
    assert scanned is True
    assert confidence is not None
    assert abs(confidence - 0.7) < 1e-9


def test_a_result_without_confidence_is_not_scanned() -> None:
    """A docling version that stops reporting confidence must fall back to "not scanned", never
    crash the ingestion of every PDF."""
    assert ocr_provenance(_Result(None)) == (False, None)
    assert ocr_provenance(object()) == (False, None)


def test_the_dead_cells_probe_is_gone() -> None:
    """The regression: reading a field the vendor's model does not have is indistinguishable from
    reading a field that is legitimately empty, which is why this survived unnoticed.

    Checked over the parsed AST, not the file text. A substring search hits this module's own
    explanation of the defect — the same over-broad grep that flagged the AUDIT-083 Dockerfile
    comment and a correct compose default. Prose that describes a bug is not the bug.
    """
    import ast
    from pathlib import Path

    source = (
        Path(__file__).resolve().parents[3] / "src" / "rsc_brain" / "ingest" / "parser.py"
    ).read_text(encoding="utf-8")
    attributes = {
        node.attr for node in ast.walk(ast.parse(source)) if isinstance(node, ast.Attribute)
    }
    literals = {
        node.value
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
    }
    # `getattr(x, "from_ocr", ...)` puts the name in a string literal, not an Attribute node, so
    # both spellings have to be excluded — the original defect used exactly that form.
    reads_from_ocr = "from_ocr" in attributes or any(
        literal == "from_ocr" for literal in literals if len(literal) < 40
    )
    assert not reads_from_ocr, (
        "the parser still reads `from_ocr`, an attribute docling's page model does not define, so "
        "`scanned` is False for every document"
    )
