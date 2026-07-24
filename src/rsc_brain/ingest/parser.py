"""Document parsing (FR-1.3/1.4). The pipeline depends only on the :class:`DocumentParser`
protocol, so the deterministic :class:`MarkdownParser` (tested default + eval-corpus driver) and
the production :class:`DoclingParser` (layout-aware PDF + Tesseract OCR) feed it identically.

Native-vs-scanned detection (FR-1.3) and OCR confidence (FR-1.4) live in :class:`DoclingParser`.
``docling`` is a heavy, operator-installed backend (torch); it is lazy-imported so this module —
and the whole default install — never depends on it. Live PDF parsing is therefore
blocked-by-resource in CI; the pipeline is proven end-to-end via the Markdown path over the
SPEC-02 corpus (whose source of truth is markdown, not the generated PDFs).
"""

from __future__ import annotations

import re
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


class DoclingParser:
    """Production PDF parser (FR-1.3/1.4). Uses Docling for layout-aware conversion + Tesseract
    OCR (``spa+eng``) on scanned pages, delegating block structuring to :class:`MarkdownParser`
    over Docling's markdown export. ``docling`` is lazy-imported: it is an operator-provided
    extra (``uv sync`` cannot pull torch into the locked graph), so this class raises a clear
    error if it is not installed. Live parsing is blocked-by-resource in CI (models absent)."""

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
            from docling.document_converter import DocumentConverter
        except ModuleNotFoundError as exc:  # pragma: no cover - operator-provided extra
            raise RuntimeError(
                "DoclingParser requires the 'docling' backend, which is an operator-installed "
                "extra (heavy, includes torch). Install it (e.g. `uv pip install docling`) to "
                "enable layout-aware PDF parsing + OCR."
            ) from exc
        return DocumentConverter()


def _docling_convert(
    converter: Any, data: bytes, filename: str
) -> tuple[Any, bool, float | None]:  # pragma: no cover - blocked-by-resource (no models in CI)
    """Convert bytes with Docling, returning (docling_document, scanned, mean_ocr_confidence).

    Native-vs-scanned is decided by extractable-text density: a document Docling had to OCR
    yields OCR cells with per-cell confidence; a native PDF exposes an embedded text layer with
    no OCR pass. This runs only where docling + Tesseract models are installed."""
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / filename
        path.write_bytes(data)
        result = converter.convert(path)
        document = result.document
    confidences = _docling_ocr_confidences(document)
    scanned = bool(confidences)
    mean = sum(confidences) / len(confidences) if confidences else None
    return document, scanned, mean


def _docling_ocr_confidences(document: Any) -> list[float]:  # pragma: no cover
    """Collect per-cell OCR confidences from a Docling document, if it was OCR'd."""
    values: list[float] = []
    for page in getattr(document, "pages", {}).values():
        for cell in getattr(page, "cells", []):
            conf = getattr(cell, "confidence", None)
            if isinstance(conf, int | float) and getattr(cell, "from_ocr", False):
                values.append(float(conf))
    return values


def _docling_page_count(document: Any) -> int | None:  # pragma: no cover
    pages = getattr(document, "pages", None)
    return len(pages) if pages is not None else None
