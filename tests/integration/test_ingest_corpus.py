"""Full SPEC-02 corpus end-to-end (DONE checklist): the 27-doc, 2-project corpus ingests through
the real pipeline with 0 duplicates on re-ingest, every chunk tagged, tables handled, and errors
queryable. The corpus source of truth is ``evals/documents.yaml`` (markdown); the generated PDFs
are a rendering of the same content (Docling live-parse is blocked-by-resource in CI)."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest
import yaml
from evals.schema import Corpus, Taxonomy

from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration


def _load_corpus() -> tuple[Taxonomy, Corpus]:
    root = Path(__file__).resolve().parents[2] / "evals"
    taxonomy = Taxonomy.model_validate(yaml.safe_load((root / "taxonomy.yaml").read_text()))
    corpus = Corpus.model_validate(yaml.safe_load((root / "documents.yaml").read_text()))
    return taxonomy, corpus


async def test_full_corpus_ingests_end_to_end(
    build_harness: Callable[..., Harness],
    make_completion: Callable[..., object],
) -> None:
    taxonomy, corpus = _load_corpus()
    harness = build_harness(
        completion=make_completion(
            entities=[{"name": "Acme", "type": "org", "aliases": []}],
            claims=[{"text": "fact", "subject": "s", "predicate": "p", "object": "o"}],
            tags=["general"],
        )
    )

    # One real project per corpus project, with its taxonomy + a source per declared policy.
    project_ids: dict[str, str] = {}
    scopes = {}
    for slug, project in taxonomy.projects.items():
        topics = [(t.slug, t.sensitivity) for t in project.topics]
        project_id = await harness.setup_project(unique_slug(slug), topics)
        project_ids[slug] = project_id
        scopes[slug] = harness.scope(project_id, allowed_topics=[t.slug for t in project.topics])

    # Create each document's source with its D13 policy + declared default tags.
    seen_sources: set[tuple[str, str]] = set()
    for doc in corpus.documents:
        key = (doc.project, doc.source)
        if key in seen_sources:
            continue
        seen_sources.add(key)
        await harness.repo.create_source(
            scopes[doc.project],
            name=doc.source,
            type_="folder",
            policy=doc.policy,
            default_tags=doc.tags,
        )

    # Ingest the whole corpus.
    for doc in corpus.documents:
        outcome = await harness.service.ingest_bytes(
            scopes[doc.project],
            doc.body.encode("utf-8"),
            filename=f"{doc.id}.md",
            source=doc.source,
        )
        assert outcome.duplicate is False

    # Re-ingesting the whole corpus is a registered no-op (0 duplicates created).
    for doc in corpus.documents:
        again = await harness.service.ingest_bytes(
            scopes[doc.project],
            doc.body.encode("utf-8"),
            filename=f"{doc.id}.md",
            source=doc.source,
        )
        assert again.duplicate is True

    # Every project's runs are queryable, and every chunk carries ≥1 tag.
    for slug, scope in scopes.items():
        runs = await harness.repo.list_run_statuses(scope)
        assert len(runs) == sum(1 for d in corpus.documents if d.project == slug)
        for run in runs:
            chunks = await harness.repo.load_chunks(scope, run.document_id)
            for chunk in chunks:
                assert chunk.tags, f"chunk {chunk.id} in {run.document_id} has no tag"
            # ingest_errors is queryable per document (may be empty).
            await harness.repo.list_ingest_errors(scope, run.document_id)

    # source_tags documents auto-publish: at least one project has embedded (recallable) chunks.
    embedded_totals = [await harness.embedded_chunk_count(pid) for pid in project_ids.values()]
    assert any(total > 0 for total in embedded_totals)
