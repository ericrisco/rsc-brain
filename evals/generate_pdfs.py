"""Render the corpus (`documents.yaml`) to PDFs (SPEC-02 E12.3).

`documents.yaml` is the source of truth. This materializes each document as a PDF into
`evals/pdfs/`: native (a real text layer) for `prose`/`table`, and a **rasterized, text-layer-free
page** for `kind: scanned` (a PIL image drawn onto the PDF) so ingestion's native-vs-scanned
detection (FR-1.3) sends it down the OCR path. Requires the `evals` dependency group
(``uv run --group evals python -m evals.generate_pdfs``).
"""

from __future__ import annotations

from pathlib import Path

import yaml

from evals.schema import Corpus, Document

OUT_DIR = Path(__file__).resolve().parent / "pdfs"


def _render_native(document: Document, path: Path) -> None:
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    pdf = canvas.Canvas(str(path), pagesize=A4)
    text = pdf.beginText(56, 780)
    text.setFont("Helvetica", 11)
    for line in _wrap(f"[{document.id}] {document.body.strip()}"):
        text.textLine(line)
    pdf.drawText(text)
    pdf.showPage()
    pdf.save()


def _render_scanned(document: Document, path: Path) -> None:
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (1240, 1754), "white")  # ~A4 at 150 dpi
    draw = ImageDraw.Draw(image)
    y = 60
    for line in _wrap(f"[{document.id}] {document.body.strip()}"):
        draw.text((60, y), line, fill="black")
        y += 22
    image.save(str(path), "PDF", resolution=150.0)  # image-only PDF: no text layer


def _wrap(text: str, width: int = 90) -> list[str]:
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        if len(current) + len(word) + 1 > width:
            lines.append(current)
            current = word
        else:
            current = f"{current} {word}".strip()
    if current:
        lines.append(current)
    return lines


def generate() -> int:
    corpus = Corpus(
        **yaml.safe_load((Path(__file__).resolve().parent / "documents.yaml").read_text())
    )
    OUT_DIR.mkdir(exist_ok=True)
    for document in corpus.documents:
        path = OUT_DIR / f"{document.id}.pdf"
        if document.kind == "scanned":
            _render_scanned(document, path)
        else:
            _render_native(document, path)
    print(f"Wrote {len(corpus.documents)} PDFs to {OUT_DIR}")
    return len(corpus.documents)


if __name__ == "__main__":
    generate()
