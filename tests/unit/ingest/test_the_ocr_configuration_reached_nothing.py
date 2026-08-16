"""AUDIT-087: the parser declared its OCR languages and never passed them to anything.

`DoclingParser.__init__` takes `ocr_languages=("spa", "eng")` and stores it. A grep over the whole
repository found the name on exactly two lines — the parameter and the assignment. It was never
read. `_converter()` returned a bare `DocumentConverter()`, so every OCR decision belonged to the
vendor's defaults rather than to the product.

Three consequences, all measured on a real host rather than reasoned about:

1. The docstrings promised "Tesseract OCR (``spa+eng``)". The worker ran **RapidOCR**, whose
   `RapidOcrOptions.lang` defaults to `['chinese']`. A Spanish-and-English company memory was
   OCR-ing scanned pages with a Chinese-language recognition model.
2. The rapidocr wheel ships PP-OCRv6 as `.onnx`, and rapidocr's own default engine is
   `onnxruntime` — but that runtime was not installed in the image. The engine fell back to torch
   and downloaded a parallel set of `.pth` weights from huggingface.co, unauthenticated, on the
   first scanned page. Measured: 3 files at build time, 7 files and 62 MB after one PDF.
3. So an install with restricted egress passed the build, passed `brain verify`, accepted the
   upload with `202`, and only then failed — while `deploy/README.md` states that building the
   image once is enough.

The live conversion cannot be tested here: docling is an operator-installed extra and is absent
from the locked graph, which is exactly why this went unnoticed. What these tests hold is the part
that does not need it — the language mapping, and the structural property that the declaration
reaches the converter at all.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

from rsc_brain.ingest.parser import DoclingParser, resolve_ocr_models

REPO = Path(__file__).resolve().parents[3]
PARSER = REPO / "src" / "rsc_brain" / "ingest" / "parser.py"
DOCKERFILE = REPO / "Dockerfile"


@pytest.mark.parametrize(
    ("languages", "expected"),
    [
        (("spa", "eng"), ["latin"]),  # one model covers both; `latin` subsumes `en`
        (("eng",), ["en"]),
        (("spa",), ["latin"]),
        (("cat", "spa"), ["latin"]),
        ((), ["en"]),  # never fall through to the vendor default
        (("klingon",), ["en"]),  # an unknown code must not reach the engine
    ],
)
def test_languages_map_to_recognition_models(
    languages: tuple[str, ...], expected: list[str]
) -> None:
    assert resolve_ocr_models(languages) == expected


def test_no_mapping_ever_yields_chinese() -> None:
    """The defect's signature. `chinese` is RapidOCR's default and must never be what we ask for."""
    for languages in [("spa", "eng"), ("eng",), (), ("unknown",), ("spa", "cat", "por")]:
        assert "chinese" not in resolve_ocr_models(languages)
        assert "ch" not in resolve_ocr_models(languages)


def test_the_declaration_reaches_the_converter() -> None:
    """The regression itself: `_converter` must read `_ocr_languages` and configure the pipeline.

    Asserted structurally because a live conversion needs docling, an operator-installed extra
    absent from CI — the same absence under which this defect shipped. A bare `DocumentConverter()`
    is precisely what the defect looked like.
    """
    tree = ast.parse(PARSER.read_text(encoding="utf-8"))
    converter = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and node.name == "_converter"
    )
    source = ast.unparse(converter)

    assert "_ocr_languages" in source, (
        "_converter ignores the declared OCR languages, so `ocr_languages` is dead configuration "
        "and the engine falls back to its own default (Chinese)"
    )
    assert "ocr_options" in source, "no OCR options are passed; the vendor's defaults govern"
    assert "onnxruntime" in source, (
        "the OCR engine is unpinned, so it selects torch and downloads weights at first use "
        "despite the image shipping the ONNX models"
    )
    assert "format_options" in source, (
        "the pipeline options are built but never attached to the converter"
    )


def test_the_image_installs_the_runtime_its_models_need() -> None:
    """Pinning the engine is only half the fix: without `onnxruntime` installed, RapidOCR raises
    `ImportError: onnxruntime is not installed.` and OCR stops entirely.

    This assertion exists because the first version of the fix did exactly that, and was caught by
    running it against the real image instead of trusting the reasoning.
    """
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    assert "onnxruntime" in dockerfile, (
        "the image pins the ONNX engine in code but never installs it, so every scanned PDF fails"
    )


def test_the_parser_no_longer_promises_an_engine_it_does_not_run() -> None:
    """The docstrings named Tesseract. The runtime was RapidOCR. A promise nobody kept."""
    source = PARSER.read_text(encoding="utf-8")
    claims = [
        line
        for line in source.splitlines()
        if "Tesseract" in line and "AUDIT-087" not in line and "docstring said" not in line
    ]
    assert not claims, f"the parser still promises Tesseract: {claims}"


def test_the_default_is_still_the_declared_scope() -> None:
    """`spa+eng` is the product's stated language scope; the fix must not quietly narrow it."""
    parser = DoclingParser()
    assert parser._ocr_languages == ("spa", "eng")


def test_the_image_warms_the_models_this_product_asks_for() -> None:
    """Pinning the engine removed the torch download and left a smaller one.

    The rapidocr wheel bundles only the CHINESE PP-OCRv6 models, so asking for `latin` — the model
    that reads Spanish, the product's declared scope — still fetched two `.onnx` on the first
    scanned page. Measured: 4 downloads before the fix, 2 after, the right language and still over
    the wire. Half a fix is still a network dependency at first use.
    """
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    assert "LangRec.LATIN" in dockerfile, (
        "the build never warms the Latin recognition model, so a Spanish scan still downloads it "
        "at first use — on an air-gapped host, never"
    )
    assert "latin_PP-OCRv5_rec" in dockerfile, (
        "the build does not assert the warmed model is on disk, so a silent fetch failure ships an "
        "image that looks complete and is not (the AUDIT-083 rule)"
    )
