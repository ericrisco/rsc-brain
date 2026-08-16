"""Document parsing (FR-1.3/1.4). The pipeline depends only on the :class:`DocumentParser`
protocol, so the deterministic :class:`MarkdownParser` (tested default + eval-corpus driver) and
the production :class:`DoclingParser` (layout-aware PDF + RapidOCR) feed it identically.

Native-vs-scanned detection (FR-1.3) and OCR confidence (FR-1.4) live in :class:`DoclingParser`.
``docling`` is a heavy, operator-installed backend (torch); it is lazy-imported so this module —
and the whole default install — never depends on it. Live PDF parsing is therefore
blocked-by-resource in CI; the pipeline is proven end-to-end via the Markdown path over the
SPEC-02 corpus (whose source of truth is markdown, not the generated PDFs).
"""

from __future__ import annotations

import math
import re
from collections.abc import Sequence
from typing import Any, Protocol

from rsc_brain.ingest.types import ParsedDocument, ProseBlock, TableBlock

_HEADING = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")
_TABLE_SEP = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$")


class DocumentParser(Protocol):
    """Turns raw document bytes into a backend-independent :class:`ParsedDocument`."""

    def parse(
        self, data: bytes, *, filename: str, lang_hint: str | None = None
    ) -> ParsedDocument: ...


def _split_table_row(line: str) -> list[str]:
    """Split a GFM pipe-table row into trimmed cells (ignoring the outer pipes)."""
    cells = line.strip().strip("|").split("|")
    return [c.strip() for c in cells]


class MarkdownParser:
    """Deterministic markdown parser: headings + paragraphs → prose blocks, GFM pipe tables →
    :class:`TableBlock`. ``scanned`` stamps every block with ``ocr_confidence`` so the
    OCR-confidence propagation path (FR-1.4) is exercised without a live OCR engine."""

    def __init__(self, *, scanned: bool = False, ocr_confidence: float | None = None) -> None:
        self._scanned = scanned
        self._confidence = (
            ocr_confidence if ocr_confidence is not None else (0.85 if scanned else None)
        )

    def parse(self, data: bytes, *, filename: str, lang_hint: str | None = None) -> ParsedDocument:
        text = data.decode("utf-8")
        lines = text.splitlines()
        prose: list[ProseBlock] = []
        tables: list[TableBlock] = []
        title: str | None = None
        heading: str | None = None
        para: list[str] = []
        i = 0

        def flush_para() -> None:
            if para:
                body = " ".join(s.strip() for s in para).strip()
                if body:
                    prose.append(
                        ProseBlock(
                            text=body,
                            page=1,
                            heading=heading,
                            extraction_confidence=self._confidence,
                        )
                    )
                para.clear()

        while i < len(lines):
            line = lines[i]
            heading_match = _HEADING.match(line)
            if heading_match is not None:
                flush_para()
                heading = heading_match.group(2)
                if title is None and heading_match.group(1) == "#":
                    title = heading
                i += 1
                continue
            # A GFM table: header row, a separator row, then data rows.
            if "|" in line and i + 1 < len(lines) and _TABLE_SEP.match(lines[i + 1]):
                flush_para()
                header = tuple(_split_table_row(line))
                i += 2
                rows: list[tuple[str, ...]] = []
                while i < len(lines) and "|" in lines[i] and lines[i].strip():
                    rows.append(tuple(_split_table_row(lines[i])))
                    i += 1
                tables.append(
                    TableBlock(
                        header=header,
                        rows=tuple(rows),
                        page=1,
                        caption=heading,
                        extraction_confidence=self._confidence,
                    )
                )
                continue
            if not line.strip():
                flush_para()
            else:
                para.append(line)
            i += 1
        flush_para()

        return ParsedDocument(
            title=title,
            lang=lang_hint,
            pages=1,
            scanned=self._scanned,
            prose_blocks=tuple(prose),
            tables=tuple(tables),
        )


# AUDIT-087: the product declares its OCR languages; RapidOCR — the engine docling actually runs
# here — names its recognition models by script, not by ISO code. There is no Spanish model: the
# `latin` model is the one that reads Spanish, and it reads English too. Mapping is explicit rather
# than clever, so a language added later is a visible decision instead of a silent fallback to
# whatever the vendor's default happens to be (which was Chinese).
_OCR_LANGUAGE_MODELS: dict[str, str] = {
    "spa": "latin",
    "eng": "en",
    "cat": "latin",
    "por": "latin",
    "fra": "latin",
    "deu": "latin",
    "ita": "latin",
}


def resolve_ocr_models(languages: Sequence[str]) -> list[str]:
    """The RapidOCR recognition models that cover ``languages``.

    ``latin`` subsumes ``en``, so a request for Spanish and English needs one model, not two.
    Unknown codes are dropped rather than passed through: an unrecognised value reaching the engine
    is how the default (Chinese) got selected in the first place.
    """
    models = {_OCR_LANGUAGE_MODELS[code] for code in languages if code in _OCR_LANGUAGE_MODELS}
    if "latin" in models:
        models.discard("en")
    return sorted(models) or ["en"]


class DoclingParser:
    """Production PDF parser (FR-1.3/1.4). Uses Docling for layout-aware conversion + RapidOCR on
    scanned pages, delegating block structuring to :class:`MarkdownParser` over Docling's markdown
    export. ``docling`` is lazy-imported: it is an operator-provided extra (``uv sync`` cannot pull
    torch into the locked graph), so this class raises a clear error if it is not installed. Live
    parsing is blocked-by-resource in CI (models absent).

    AUDIT-087: this class used to take ``ocr_languages``, store it, and never read it. It built a
    bare ``DocumentConverter()``, so every OCR decision was the vendor's default rather than the
    product's declaration. Measured on a real host: the docstring said "Tesseract OCR (``spa+eng``)"
    while the worker ran RapidOCR with ``lang=['chinese']``, and fetched 32 MB of torch weights from
    huggingface.co on the first scanned page — although the image already ships the ONNX models
    RapidOCR's own default backend prefers. The declaration now reaches the converter.
    """

    def __init__(
        self,
        *,
        vision_enabled: bool = False,
        ocr_languages: tuple[str, ...] = ("spa", "eng"),
    ) -> None:
        self._vision_enabled = vision_enabled  # FR-1.11: VLM is v2; reserved, default off
        self._ocr_languages = ocr_languages

    def parse(self, data: bytes, *, filename: str, lang_hint: str | None = None) -> ParsedDocument:
        converter = self._converter()
        document, scanned, confidence = _docling_convert(converter, data, filename)
        markdown = document.export_to_markdown()
        # Reuse the markdown structurer; stamp OCR confidence when the source was scanned.
        structured = MarkdownParser(scanned=scanned, ocr_confidence=confidence).parse(
            markdown.encode("utf-8"), filename=filename, lang_hint=lang_hint
        )
        page_count = _docling_page_count(document)
        return ParsedDocument(
            title=structured.title,
            lang=lang_hint,
            pages=page_count or structured.pages,
            scanned=scanned,
            prose_blocks=structured.prose_blocks,
            tables=structured.tables,
        )

    def _converter(self) -> Any:
        try:
            from docling.datamodel.base_models import InputFormat
            from docling.datamodel.pipeline_options import PdfPipelineOptions, RapidOcrOptions
            from docling.document_converter import DocumentConverter, PdfFormatOption
        except ModuleNotFoundError as exc:  # pragma: no cover - operator-provided extra
            raise RuntimeError(
                "DoclingParser requires the 'docling' backend, which is an operator-installed "
                "extra (heavy, includes torch). Install it (e.g. `uv pip install docling`) to "
                "enable layout-aware PDF parsing + OCR."
            ) from exc

        ocr = RapidOcrOptions(
            lang=resolve_ocr_models(self._ocr_languages),
            # The image ships RapidOCR's ONNX models; `onnxruntime` is also RapidOCR's own default.
            # Left unpinned, docling selected the torch engine and downloaded a parallel set of
            # `.pth` weights from huggingface.co, unauthenticated, on the first scanned page — so an
            # install with restricted egress passed the build, passed `brain verify`, accepted the
            # upload with 202, and only then failed. Pinning it makes `deploy/README.md`'s "building
            # it once is enough" true.
            backend="onnxruntime",
        )
        pipeline_options = PdfPipelineOptions(do_ocr=True, ocr_options=ocr)
        return DocumentConverter(
            format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)}
        )


def ocr_provenance(result: Any) -> tuple[bool, float | None]:
    """Whether Docling OCR'd this document (FR-1.3), and how confidently (FR-1.4).

    AUDIT-090: this used to read ``page.cells[*].from_ocr``. Docling's page model has **no
    ``cells`` attribute at all** — its only real field is ``image`` — so ``getattr(page, "cells",
    [])`` returned the empty default on every document ever ingested. `scanned` was therefore
    always ``False`` and `ocr_confidence` always ``None``: two named functional requirements that
    silently returned "nothing happened" for every file, in a function marked ``# pragma: no
    cover``. The Markdown path stamps `scanned` from a constructor flag, so the tests proved the
    *propagation* while nothing proved the *detection*.

    The discriminator below was found by converting a rasterised PDF and a native one and
    comparing, rather than by guessing at an API:

        07-scanned.pdf   (image only)   parse_score=nan   ocr_score=0.9459
        05-native.pdf    (text layer)   parse_score=1.0   ocr_score=nan

    ``ocr_score`` is a real number exactly when OCR ran, and ``nan`` when it did not — per page, so
    a mixed document averages only the pages that were actually OCR'd.
    """
    confidence = getattr(result, "confidence", None)
    pages = getattr(confidence, "pages", None) or {}
    scores = [
        float(score)
        for page in pages.values()
        if isinstance(score := getattr(page, "ocr_score", None), (int, float))
        and not math.isnan(float(score))
    ]
    if not scores:
        return False, None
    return True, sum(scores) / len(scores)


def _docling_convert(
    converter: Any, data: bytes, filename: str
) -> tuple[Any, bool, float | None]:  # pragma: no cover - blocked-by-resource (no models in CI)
    """Convert bytes with Docling, returning (docling_document, scanned, mean_ocr_confidence).

    Native-vs-scanned is decided by whether Docling ran OCR at all: a rasterised page has no
    embedded text layer, so Docling OCRs it and records a confidence; a native PDF exposes a text
    layer and records none. This runs only where docling and its OCR models are installed."""
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / filename
        path.write_bytes(data)
        result = converter.convert(path)
        document = result.document
    scanned, mean = ocr_provenance(result)
    return document, scanned, mean


def _docling_page_count(document: Any) -> int | None:  # pragma: no cover
    pages = getattr(document, "pages", None)
    return len(pages) if pages is not None else None
