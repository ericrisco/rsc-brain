"""Live SPEC-02 prompt iteration over the explicit foundational quality sample.

This runner measures production ``CascadeExtractor`` and ``Topicalizer`` adapters. It deliberately
leaves ``semantic_reviewed`` false: generated numbers cannot certify their own semantic review.
Run the candidate, inspect every recorded result, then promote reviewed evidence explicitly.
"""

from __future__ import annotations

import argparse
import asyncio
from datetime import UTC, datetime
from pathlib import Path

import yaml

from evals.schema import (
    Corpus,
    FoundationalCaseResult,
    FoundationalEvidence,
    Taxonomy,
)
from evals.validate import (
    REPO,
    foundational_fingerprint,
    load_artifact_manifest,
    load_quality_manifest,
)
from rsc_brain.config.models import CapabilitiesConfig, CapabilityConfig, ModelEgressConfig
from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.ingest.extractor import CascadeExtractor, ExtractionDiscarded
from rsc_brain.ingest.tables import table_to_chunks
from rsc_brain.ingest.topicalizer import Topicalizer
from rsc_brain.ingest.types import ExtractedGraph, ProposedChunk, TableBlock


def _load_corpus(repo: Path) -> Corpus:
    path = repo / "evals" / "documents.yaml"
    return Corpus.model_validate(yaml.safe_load(path.read_text(encoding="utf-8")))


def _load_taxonomy(repo: Path) -> Taxonomy:
    path = repo / "evals" / "taxonomy.yaml"
    return Taxonomy.model_validate(yaml.safe_load(path.read_text(encoding="utf-8")))


def _graph_terms(graph: ExtractedGraph) -> tuple[str, ...]:
    values: list[str] = []
    for entity in graph.entities:
        values.extend((entity.name, entity.type, *entity.aliases))
    for relation in graph.relations:
        values.extend((relation.subject, relation.predicate, relation.object))
    for claim in graph.claims:
        values.extend(
            value
            for value in (claim.text, claim.subject, claim.predicate, claim.object)
            if value is not None
        )
    return tuple(dict.fromkeys(value for value in values if value))


def _table_chunks(text: str) -> tuple[ProposedChunk, ...]:
    """Parse the eval corpus' explicit pipe-table form, then call the production converter."""
    rows = [tuple(cell.strip() for cell in line.split("|")) for line in text.splitlines() if line]
    if len(rows) < 2:
        raise ValueError("quality table must contain a header and at least one row")
    width = len(rows[0])
    if width < 2 or any(len(row) != width for row in rows[1:]):
        raise ValueError("quality table rows must match the header width")
    chunks = tuple(table_to_chunks(TableBlock(header=rows[0], rows=tuple(rows[1:]))))
    if any(chunk.needs_review for chunk in chunks):
        raise ValueError("quality table unexpectedly requires review")
    return chunks


def _table_graph_terms(chunks: tuple[ProposedChunk, ...]) -> tuple[str, ...]:
    values: list[str] = []
    for chunk in chunks:
        values.append(chunk.text)
        for claim in chunk.claims:
            values.extend(
                value
                for value in (claim.text, claim.subject, claim.predicate, claim.object)
                if value is not None
            )
    return tuple(dict.fromkeys(values))


def _missing(needles: tuple[str, ...], values: tuple[str, ...]) -> tuple[str, ...]:
    haystack = "\n".join(values).casefold()
    return tuple(needle for needle in needles if needle.casefold() not in haystack)


def _present(needles: tuple[str, ...], values: tuple[str, ...]) -> tuple[str, ...]:
    haystack = "\n".join(values).casefold()
    return tuple(needle for needle in needles if needle.casefold() in haystack)


async def run_foundational_eval(
    *,
    gateway: ModelGateway,
    provider: str,
    model: str,
    model_digest: str,
    repo: Path = REPO,
) -> FoundationalEvidence:
    """Measure extraction discard rate and explicit per-document semantic expectations."""
    quality = load_quality_manifest(repo / "evals" / "foundational_quality.yaml")
    corpus = _load_corpus(repo)
    taxonomy = _load_taxonomy(repo)
    documents = {document.id: document for document in corpus.documents}
    if len(documents) != len(corpus.documents):
        raise ValueError("documents.yaml contains duplicate document ids")
    if len({case.id for case in quality.cases}) != len(quality.cases):
        raise ValueError("foundational_quality.yaml contains duplicate case ids")

    extractor = CascadeExtractor(gateway)
    topicalizer = Topicalizer(gateway)
    results: list[FoundationalCaseResult] = []
    for case in quality.cases:
        try:
            document = documents[case.document_id]
        except KeyError:
            raise ValueError(
                f"quality case {case.id}: unknown document {case.document_id}"
            ) from None
        try:
            project = taxonomy.projects[document.project]
        except KeyError:
            raise ValueError(
                f"quality case {case.id}: unknown taxonomy project {document.project}"
            ) from None
        slugs = tuple(topic.slug for topic in project.topics)
        invalid_tags = set(case.required_tags) - set(slugs)
        if invalid_tags:
            raise ValueError(
                f"quality case {case.id}: unknown required tags {sorted(invalid_tags)}"
            )

        extraction_attempted = document.kind != "table"
        discarded = False
        discard_stage: str | None = None
        if document.kind == "table":
            chunks = _table_chunks(document.body)
            graph_terms = _table_graph_terms(chunks)
            tag_texts = tuple(chunk.text for chunk in chunks)
        else:
            tag_texts = (document.body,)
            try:
                graph = await extractor.extract(document.body)
                graph_terms = _graph_terms(graph)
            except ExtractionDiscarded as exc:
                discarded = True
                discard_stage = exc.stage
                graph_terms = ()
        tag_sets = [
            await topicalizer.tag(
                text,
                taxonomy=slugs,
                rules=(),
                default_tag=slugs[0],
            )
            for text in tag_texts
        ]
        tags = tuple(dict.fromkeys(tag for tag_set in tag_sets for tag in tag_set))
        missing_tags = tuple(tag for tag in case.required_tags if tag not in tags)
        missing_terms = _missing(case.required_graph_terms, graph_terms)
        forbidden_present = _present(case.forbidden_graph_terms, graph_terms)
        passed = not (discarded or missing_tags or missing_terms or forbidden_present)
        results.append(
            FoundationalCaseResult(
                case_id=case.id,
                document_id=case.document_id,
                extraction_attempted=extraction_attempted,
                discarded=discarded,
                discard_stage=discard_stage,
                tags=tags,
                graph_terms=graph_terms,
                missing_tags=missing_tags,
                missing_graph_terms=missing_terms,
                forbidden_graph_terms_present=forbidden_present,
                passed=passed,
            )
        )

    discards = sum(result.discarded for result in results)
    passes = sum(result.passed for result in results)
    manifest = load_artifact_manifest(repo / "evals" / "foundational_manifest.yaml")
    prompt_versions = {
        artifact.id: artifact.version
        for artifact in manifest.artifacts
        if artifact.kind == "prompt" and artifact.foundational
    }
    sample_size = len(results)
    extraction_attempts = sum(result.extraction_attempted for result in results)
    return FoundationalEvidence(
        schema_version=1,
        run_at=datetime.now(UTC),
        provider=provider,
        model=model,
        model_digest=model_digest,
        content_fingerprint=foundational_fingerprint(repo),
        prompt_versions=prompt_versions,
        sample_size=sample_size,
        extraction_attempts=extraction_attempts,
        extraction_discards=discards,
        discard_rate=discards / extraction_attempts,
        quality_cases_passed=passes,
        quality_cases_total=sample_size,
        semantic_review="assisted",
        semantic_reviewed=False,
        results=tuple(results),
    )


def _gateway_from_args(args: argparse.Namespace) -> ModelGateway:
    # AUDIT-005 refuses a plain-HTTP or private-network model endpoint unless the operator grants it.
    # This eval's whole point is a local model, so the grant is expressed here the same way the
    # configuration file expresses it — explicitly, per run, never inferred from the URL.
    route = CapabilityConfig(
        provider=args.provider,
        model=args.model,
        api_base=args.api_base,
        timeout_s=args.timeout_s,
        egress=ModelEgressConfig(
            allow_http=args.allow_http,
            allow_private_network=args.allow_private_network,
        ),
    )
    capabilities = CapabilitiesConfig(
        extractor=route,
        judge=route,
        topicalizer=route,
        embedder=route,
    )
    return ModelGateway(capabilities)


async def _main_async(args: argparse.Namespace) -> int:
    evidence = await run_foundational_eval(
        gateway=_gateway_from_args(args),
        provider=args.provider,
        model=args.model,
        model_digest=args.model_digest,
    )
    args.output.write_text(
        yaml.safe_dump(evidence.model_dump(mode="json"), sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )
    print(
        f"candidate={args.output} discards={evidence.extraction_discards}/"
        f"{evidence.extraction_attempts} quality={evidence.quality_cases_passed}/"
        f"{evidence.quality_cases_total} semantic_review=pending"
    )
    return 0 if evidence.discard_rate < 0.10 and all(r.passed for r in evidence.results) else 1


def _parser() -> argparse.ArgumentParser:
    """The command line, extracted so a test can exercise it without running the eval."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", default="ollama")
    parser.add_argument("--model", required=True)
    parser.add_argument("--model-digest", required=True)
    parser.add_argument("--api-base", default="http://localhost:11434")
    parser.add_argument("--timeout-s", type=float, default=300.0)
    parser.add_argument(
        "--allow-http",
        action="store_true",
        help="Permit a plain-HTTP model endpoint (AUDIT-005 denies one by default).",
    )
    parser.add_argument(
        "--allow-private-network",
        action="store_true",
        help="Permit a loopback or RFC1918 model endpoint (AUDIT-005 denies one by default).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=REPO / "evals" / "foundational_evidence.candidate.yaml",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    return asyncio.run(_main_async(_parser().parse_args(argv)))


if __name__ == "__main__":
    raise SystemExit(main())
