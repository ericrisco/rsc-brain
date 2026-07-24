"""MarkdownParser: headings, paragraphs, GFM tables, and OCR-confidence stamping."""

from __future__ import annotations

from rsc_brain.ingest.parser import MarkdownParser

_DOC = b"""# Title

First paragraph of prose.

## Section

Second paragraph here.

| employee | salary |
| --- | --- |
| Ada | 90000 |
| Linus | 85000 |
"""


def test_markdown_parses_prose_and_tables() -> None:
    parsed = MarkdownParser().parse(_DOC, filename="doc.md")
    assert parsed.title == "Title"
    assert len(parsed.prose_blocks) == 2
    assert parsed.prose_blocks[1].heading == "Section"
    assert len(parsed.tables) == 1
    table = parsed.tables[0]
    assert table.header == ("employee", "salary")
    assert table.rows == (("Ada", "90000"), ("Linus", "85000"))
    assert table.has_clear_header is True


def test_scanned_stamps_ocr_confidence() -> None:
    parsed = MarkdownParser(scanned=True, ocr_confidence=0.6).parse(_DOC, filename="scan.md")
    assert parsed.scanned is True
    assert all(b.extraction_confidence == 0.6 for b in parsed.prose_blocks)
    assert parsed.tables[0].extraction_confidence == 0.6


def test_native_has_no_confidence() -> None:
    parsed = MarkdownParser().parse(_DOC, filename="doc.md")
    assert parsed.scanned is False
    assert all(b.extraction_confidence is None for b in parsed.prose_blocks)
