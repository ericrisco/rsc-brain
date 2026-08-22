"""A source name shared by documents with different tags widened every one of them (AUDIT-140).

`_sources` built one source row per `(project, name)` and set its default tags to the UNION of the
tags of every document declaring that name, defended in a comment as "the way an operator declaring a
folder once would". That is true of a folder and false of this corpus, which declares tags per
DOCUMENT. Under `policy: source_tags` the source's default tags are what gets applied, so each
document silently acquired its siblings' topics. The first document's policy also won, discarding the
others'.

Measured on the shipped corpus before the fix: `acme/wiki`, `acme/hr-drive` and `globex/legal-drive`
were affected, and two documents became readable by principals the corpus does not grant their topic
to — which G2 reported as zero leaks, because the leak metric read the same widened tags (AUDIT-139).
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from evals.gate_run import EVALS, _source_rows
from evals.schema import Corpus, Document
from evals.validate import check_source_tags_are_declared_per_document


def _document(**overrides: object) -> Document:
    base: dict[str, object] = {
        "id": "d",
        "project": "acme",
        "source": "wiki",
        "policy": "source_tags",
        "tags": ["engineering"],
        "kind": "prose",
        "lang": "en",
        "body": "text",
    }
    return Document.model_validate(base | overrides)


def test_the_shipped_corpus_declares_one_tag_set_per_source() -> None:
    corpus = Corpus.model_validate(yaml.safe_load((EVALS / "documents.yaml").read_text("utf-8")))

    rows = _source_rows(corpus)

    for document in corpus.documents:
        _, tags = rows[(document.project, document.source)]
        assert set(tags) == set(document.tags), (
            f"{document.id} would be ingested with {sorted(tags)} while declaring "
            f"{sorted(document.tags)} — the widening AUDIT-140 removed"
        )


def test_two_tag_sets_under_one_source_name_are_refused() -> None:
    corpus = Corpus(
        documents=[
            _document(id="narrow", tags=["engineering"]),
            _document(id="wide", tags=["engineering", "general"]),
        ]
    )

    with pytest.raises(SystemExit) as raised:
        _source_rows(corpus)

    message = str(raised.value)
    assert "acme/wiki" in message
    assert "narrow" in message and "wide" in message
    assert "siblings" in message, "say what the union would have done, not only that it is refused"


def test_two_policies_under_one_source_name_are_refused() -> None:
    """The quieter half: the first document's policy won, so a document declaring `llm_review` was
    ingested under whatever its sibling declared."""
    corpus = Corpus(
        documents=[
            _document(id="first", policy="llm"),
            _document(id="second", policy="llm_review"),
        ]
    )

    with pytest.raises(SystemExit) as raised:
        _source_rows(corpus)

    assert "llm_review" in str(raised.value)


def test_the_same_tags_under_one_source_name_are_fine() -> None:
    """Several documents per source is the normal case and must stay cheap."""
    corpus = Corpus(documents=[_document(id="a"), _document(id="b"), _document(id="c")])

    assert _source_rows(corpus) == {("acme", "wiki"): ("source_tags", ("engineering",))}


def test_the_content_gate_enforces_it_too(tmp_path: Path) -> None:
    """Two guards in two places, because they run in two places: this one fails a release's content
    gate, the other one fails the ingest that would have widened the tags."""
    assert check_source_tags_are_declared_per_document() == []

    (tmp_path / "evals").mkdir()
    conflicting = (
        (EVALS / "documents.yaml")
        .read_text("utf-8")
        .replace("source: wiki-policy", "source: wiki", 1)
    )
    (tmp_path / "evals" / "documents.yaml").write_text(conflicting, "utf-8")

    errors = check_source_tags_are_declared_per_document(repo=tmp_path)

    assert errors and "acme/wiki" in errors[0]
    assert "tag sets" in errors[0]
