"""The ingestion pipeline orchestrator (SPEC-05, E3.10).

Two phases around the D13 approval gate:

* **Parse phase** (always, up to a tag proposal): parse → tables → chunk → topicalize. Chunks are
  persisted (so a manager can preview content + proposed tags) but **without embeddings**, so
  nothing is vector-recallable and the graph stays empty until approval.
* **Publish phase** (only once ``approved``): embed chunks, run the cascade extraction over prose
  (discarding+logging failures, never garbage to the graph), resolve entities, and write claims +
  the project graph.

Stages are checkpointed in ``ingest_runs`` and each stage is a single transaction, so a crashed
worker resumes from its last checkpoint without duplicating work (FR-1.10 / NFR-4). Parsing is
pure and cheap, so it is re-run on every invocation; the persisting/LLM stages are gated on their
checkpoints. The publish phase is atomic + idempotent (delete-then-insert claims, ON CONFLICT
entities, MERGE graph), so a redo is safe.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

from rsc_brain.config.models import HardwareProfile, KnowledgeConfig
from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.ingest.chunker import chunk_prose
from rsc_brain.ingest.entity_resolution import entity_id
from rsc_brain.ingest.extractor import CascadeExtractor, ExtractionDiscarded
from rsc_brain.ingest.parser import DoclingParser, DocumentParser, MarkdownParser
from rsc_brain.ingest.tables import tables_to_chunks
from rsc_brain.ingest.topicalizer import Topicalizer
from rsc_brain.ingest.types import (
    ChunkKind,
    DocStatus,
    ExtractedGraph,
    ParsedDocument,
    PipelineStage,
    ProposedChunk,
    RunStatus,
    SourcePolicy,
)
from rsc_brain.knowledge.contradictions import ContradictionResolver
from rsc_brain.knowledge.credibility import authority_for, initial_credibility
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore, safe_identifier
from rsc_brain.stores.graph_store import GraphEdge, GraphNode
from rsc_brain.stores.relational.ingest_repository import (
    ChunkRow,
    ClaimSpec,
    Counters,
    DocRow,
    EntitySpec,
    IngestErrorSpec,
    IngestRepository,
    SourceRow,
)

_ENTITY_LABEL = "Entity"


@dataclass(frozen=True, slots=True)
class PipelineConfig:
    hardware_profile: HardwareProfile = HardwareProfile.WORKSTATION
    sensitivity_threshold: int = 3
    default_tag: str = "general"


def default_parser_factory(doc: DocRow) -> DocumentParser:
    """Pick a parser by file type: PDFs → Docling (operator extra), markdown/text → Markdown."""
    suffix = Path(doc.path or doc.logical_id).suffix.lower()
    if suffix == ".pdf":
        return DoclingParser()
    return MarkdownParser()


class DocumentNotFoundError(LookupError):
    """The document does not exist within the caller's project (denied ≡ absent, FR-4.3)."""


def _safe_edge_type(predicate: str) -> str:
    """Sanitize a predicate into a safe Cypher edge type (never interpolates raw text)."""
    cleaned = re.sub(r"[^A-Za-z0-9_]", "_", predicate.strip()) or "related_to"
    if not re.match(r"^[A-Za-z_]", cleaned):
        cleaned = f"r_{cleaned}"
    try:
        return safe_identifier(cleaned)
    except ValueError:  # pragma: no cover - defensive
        return "related_to"


class IngestionPipeline:
    """Drives a single document through the D13 lifecycle. Idempotent and resumable."""

    def __init__(
        self,
        *,
        repository: IngestRepository,
        graph_store: AgeGraphStore,
        gateway: ModelGateway,
        parser_factory: Callable[[DocRow], DocumentParser] = default_parser_factory,
        config: PipelineConfig | None = None,
        knowledge_config: KnowledgeConfig | None = None,
        contradiction_resolver: ContradictionResolver | None = None,
    ) -> None:
        self._repo = repository
        self._graph = graph_store
        self._gateway = gateway
        self._parser_factory = parser_factory
        self._config = config or PipelineConfig()
        self._knowledge = knowledge_config or KnowledgeConfig()
        # Optional (SPEC-08): when set, contradictions are detected on-ingest over the doc's new
        # claims. Left None keeps the SPEC-05 behaviour, so existing constructors are unaffected.
        self._resolver = contradiction_resolver
        self._topicalizer = Topicalizer(gateway)
        self._extractor = CascadeExtractor(gateway)

    # --- public entry points -------------------------------------------------

    async def process(self, scope: ProjectScope, document_id: str) -> RunStatus:
        """Run the parse phase; if the source policy auto-approves, continue to publish."""
        doc = await self._require_document(scope, document_id)
        await self._repo.ensure_run(scope, document_id, phase=doc.status)
        parsed = self._parse(doc)
        await self._parse_phase(scope, doc, parsed)

        status = (await self._require_document(scope, document_id)).status
        if status == DocStatus.AUTO_APPROVED.value:
            await self._repo.set_status(scope, document_id, DocStatus.APPROVED.value)
            status = DocStatus.APPROVED.value
        if status == DocStatus.APPROVED.value:
            await self._publish(scope, document_id, parsed)
        return await self._run_status(scope, document_id)

    async def approve(
        self,
        scope: ProjectScope,
        document_id: str,
        *,
        tags: Sequence[str] | None = None,
        approver: str | None = None,
    ) -> RunStatus:
        """Approve a pending document (optionally correcting tags), then publish (FR-1.14)."""
        doc = await self._require_document(scope, document_id)
        if doc.status not in {DocStatus.PENDING_APPROVAL.value, DocStatus.AUTO_APPROVED.value}:
            raise ValueError(
                f"document {document_id} is not awaiting approval (status={doc.status})"
            )
        await self._repo.set_status(
            scope,
            document_id,
            DocStatus.APPROVED.value,
            approved_by=approver,
            doc_tags=list(tags) if tags is not None else None,
        )
        await self._repo.propagate_doc_tags(scope, document_id)
        parsed = self._parse(await self._require_document(scope, document_id))
        await self._publish(scope, document_id, parsed)
        return await self._run_status(scope, document_id)

    async def reject(self, scope: ProjectScope, document_id: str, *, reason: str) -> RunStatus:
        """Reject a document: keep the file + reason (auditable), ingest nothing (FR-1.14)."""
        await self._require_document(scope, document_id)
        await self._repo.set_status(
            scope, document_id, DocStatus.REJECTED.value, reject_reason=reason
        )
        return await self._run_status(scope, document_id)

    async def recategorize(
        self, scope: ProjectScope, document_id: str, *, tags: Sequence[str]
    ) -> RunStatus:
        """Re-tag an already-published document and repropagate to its chunks (FR-1.15)."""
        doc = await self._require_document(scope, document_id)
        if doc.status != DocStatus.PROCESSED.value:
            raise ValueError(f"document {document_id} is not published (status={doc.status})")
        await self._repo.set_status(scope, document_id, doc.status, doc_tags=list(tags))
        await self._repo.propagate_doc_tags(scope, document_id)
        return await self._run_status(scope, document_id)

    # --- parse phase ---------------------------------------------------------

    def _parse(self, doc: DocRow) -> ParsedDocument:
        if doc.path is None:
            raise ValueError(f"document {doc.id} has no stored path to parse")
        data = Path(doc.path).read_bytes()
        parser = self._parser_factory(doc)
        return parser.parse(data, filename=Path(doc.path).name, lang_hint=doc.lang)

    async def _parse_phase(
        self, scope: ProjectScope, doc: DocRow, parsed: ParsedDocument
    ) -> list[ChunkRow]:
        if await self._repo.is_stage_complete(scope, doc.id, PipelineStage.CHUNK):
            chunk_rows = await self._repo.load_chunks(scope, doc.id)
        else:
            specs, counters = self._build_chunks(parsed)
            chunk_rows = await self._repo.persist_chunks(scope, doc.id, specs, counters=counters)

        if not await self._repo.is_stage_complete(scope, doc.id, PipelineStage.TOPICALIZE):
            source = await self._resolve_source(scope, doc)
            chunk_tags, doc_tags, status = await self._topicalize_and_policy(
                scope, source, chunk_rows
            )
            await self._repo.apply_topics(
                scope, doc.id, chunk_tags=chunk_tags, doc_tags=doc_tags, status=status
            )
        return chunk_rows

    def _build_chunks(self, parsed: ParsedDocument) -> tuple[list[ProposedChunk], Counters]:
        prose = chunk_prose(parsed.prose_blocks, profile=self._config.hardware_profile)
        tables = tables_to_chunks(parsed.tables)
        specs = [*prose, *tables]
        converted = sum(1 for c in tables if not c.needs_review)
        needs_review = sum(1 for c in tables if c.needs_review)
        return specs, Counters(
            chunks_created=len(specs),
            tables_converted=converted,
            tables_needs_review=needs_review,
        )

    async def _resolve_source(self, scope: ProjectScope, doc: DocRow) -> SourceRow:
        if doc.source_id is not None:
            source = await self._repo.get_source(scope, doc.source_id)
            if source is not None:
                return source
        return await self._repo.ensure_default_source(scope)

    async def _topicalize_and_policy(
        self, scope: ProjectScope, source: SourceRow, chunk_rows: Sequence[ChunkRow]
    ) -> tuple[dict[str, tuple[str, ...]], tuple[str, ...], str]:
        topics = await self._repo.list_topics(scope)
        taxonomy = [slug for slug, _ in topics]
        sensitive = {slug for slug, sens in topics if sens >= self._config.sensitivity_threshold}
        rules = await self._repo.get_topic_rules(scope)
        default_tag = taxonomy[0] if taxonomy else self._config.default_tag
        policy = SourcePolicy(source.policy)

        chunk_tags: dict[str, tuple[str, ...]] = {}
        proposed: set[str] = set(source.default_tags)
        for row in chunk_rows:
            if row.needs_review:
                chunk_tags[row.id] = row.tags  # reserved needs_review tag, kept as-is
                continue
            model_tags = await self._topicalizer.tag(
                row.text, taxonomy=taxonomy, rules=rules, default_tag=default_tag
            )
            if policy in {SourcePolicy.MANUAL, SourcePolicy.SOURCE_TAGS}:
                # Document tags rule; the topicalizer only adds per-chunk granularity (§4.6.3).
                tags = tuple(dict.fromkeys([*source.default_tags, *model_tags]))
            else:
                tags = model_tags
                proposed.update(model_tags)
            chunk_tags[row.id] = tags or (default_tag,)

        if policy in {SourcePolicy.MANUAL, SourcePolicy.SOURCE_TAGS}:
            doc_tags = tuple(source.default_tags)
        else:
            doc_tags = tuple(sorted(proposed))
        status = _resolve_status(policy, doc_tags, sensitive, source.review_if_sensitive)
        return chunk_tags, doc_tags, status.value

    # --- publish phase -------------------------------------------------------

    async def _publish(self, scope: ProjectScope, document_id: str, parsed: ParsedDocument) -> None:
        if await self._repo.is_stage_complete(scope, document_id, PipelineStage.PERSIST):
            await self._repo.set_status(scope, document_id, DocStatus.PROCESSED.value)
            return
        chunk_rows = await self._repo.load_chunks(scope, document_id)
        # A new version only re-materialises what changed: unchanged chunks (text seen in the prior
        # version) are neither re-embedded nor re-extracted, so their prior claims keep serving with
        # their id + credibility intact (D6, AC#2). The prior version is superseded afterwards.
        prior_doc, reuse_texts = await self._version_baseline(scope, document_id)
        current_texts = {c.text for c in chunk_rows}
        embeddable = [
            c
            for c in chunk_rows
            if not c.needs_review and c.text.strip() and c.text not in reuse_texts
        ]
        embeddings = await self._embed(embeddable)

        claims: list[ClaimSpec] = list(self._table_claims(parsed, chunk_rows, reuse_texts))
        entities: list[EntitySpec] = []
        errors: list[IngestErrorSpec] = []
        nodes: list[GraphNode] = []
        edges: list[GraphEdge] = []
        discarded = 0

        for row in chunk_rows:
            if row.kind != ChunkKind.PROSE.value or row.needs_review:
                continue
            if row.text in reuse_texts:
                continue  # unchanged prose: skip extraction (0 LLM calls); prior claim stays live
            try:
                graph = await self._extractor.extract(row.text)
            except ExtractionDiscarded as exc:
                errors.append(
                    IngestErrorSpec(
                        chunk_ref=row.id,
                        stage=exc.stage,
                        error=f"structured_extraction_failed:{exc.correlation_id}",
                    )
                )
                discarded += 1
                continue
            self._collect_extraction(document_id, row, graph, claims, entities, nodes, edges)

        counters = Counters(claims_generated=len(claims), discarded_chunks=discarded)
        await self._repo.record_publish(
            scope,
            document_id,
            embeddings=embeddings,
            claims=claims,
            entities=entities,
            errors=errors,
            counters=counters,
        )
        # Graph writes are idempotent (MERGE) and happen after the relational commit; the PERSIST
        # checkpoint is set last, so a crash in between simply redoes an idempotent publish.
        await self._graph.create_graph(scope)
        if nodes:
            await self._graph.upsert_nodes(scope, nodes)
        if edges:
            await self._graph.upsert_edges(scope, edges)
        # Supersede the prior version: changed/removed chunks lose their embedding + have their
        # claims closed (valid_to=now); unchanged chunks are left intact so their claims persist
        # with the same id/credibility (D6, AC#3). Never deletes; idempotent.
        if prior_doc is not None:
            await self._repo.supersede_prior_version(scope, prior_doc.id, current_texts)
        await self._repo.mark_stage(
            scope, document_id, PipelineStage.PERSIST, phase=DocStatus.PROCESSED.value
        )
        await self._repo.set_status(scope, document_id, DocStatus.PROCESSED.value)
        await self._detect_contradictions_on_ingest(scope, document_id)

    async def _version_baseline(
        self, scope: ProjectScope, document_id: str
    ) -> tuple[DocRow | None, set[str]]:
        """For a version > 1 document, return the prior published version + the set of its chunk
        texts (the "unchanged" set). Version-1 documents get ``(None, set())`` — unchanged path."""
        doc = await self._require_document(scope, document_id)
        if doc.version <= 1:
            return None, set()
        prior = await self._repo.latest_prior_published_document(scope, doc.logical_id, doc.version)
        if prior is None:
            return None, set()
        prior_chunks = await self._repo.load_chunks(scope, prior.id)
        return prior, {c.text for c in prior_chunks}

    async def _detect_contradictions_on_ingest(self, scope: ProjectScope, document_id: str) -> None:
        """On-ingest contradiction detection over the document's new claims (SPEC-08 FR-5.2).
        No-op unless a resolver is configured (opt-in)."""
        if self._resolver is None:
            return
        await self._resolver.resolve_document(scope, document_id)

    def _claim_credibility(self, row: ChunkRow) -> float:
        """cred0 (FR-5.1) from the source chunk: table rows are most authoritative, scanned/OCR
        least; corroboration starts at a single source; freshness defaults to 1.0 at ingest."""
        if row.kind == ChunkKind.TABLE_ROW.value:
            source_kind = "table"
        elif row.extraction_confidence is not None and row.extraction_confidence < 1.0:
            source_kind = "low_quality_ocr"
        else:
            source_kind = "official_prose"
        authority = authority_for(
            source_kind,
            table=self._knowledge.authority_by_source,
            default=self._knowledge.default_authority,
        )
        return initial_credibility(
            authority=authority,
            extraction_confidence=row.extraction_confidence,
            n_independent_sources=1,
            freshness=1.0,
        )

    async def _embed(self, chunks: Sequence[ChunkRow]) -> dict[str, list[float]]:
        if not chunks:
            return {}
        vectors = await self._gateway.embed([c.text for c in chunks])
        return {chunk.id: vector for chunk, vector in zip(chunks, vectors, strict=True)}

    def _table_claims(
        self,
        parsed: ParsedDocument,
        chunk_rows: Sequence[ChunkRow],
        reuse_texts: set[str] | None = None,
    ) -> list[ClaimSpec]:
        """Recover the deterministic table-row claims and bind them to their persisted chunk by
        text (table_row text is unique per row, so the mapping is unambiguous). Rows whose text is
        unchanged from the prior version are skipped — their prior claims persist (D6, AC#2)."""
        unchanged = reuse_texts or set()
        by_text: dict[str, ChunkRow] = {
            c.text: c for c in chunk_rows if c.kind == ChunkKind.TABLE_ROW.value
        }
        specs, _ = self._build_chunks(parsed)
        claims: list[ClaimSpec] = []
        for spec in specs:
            if spec.kind is not ChunkKind.TABLE_ROW or spec.needs_review or not spec.claims:
                continue
            if spec.text in unchanged:
                continue
            row = by_text.get(spec.text)
            if row is None:
                continue
            credibility = self._claim_credibility(row)
            for triple in spec.claims:
                claims.append(
                    ClaimSpec(
                        chunk_id=row.id,
                        text=triple.text,
                        subject=triple.subject,
                        predicate=triple.predicate,
                        object=triple.object,
                        tags=row.tags,
                        extraction_confidence=row.extraction_confidence,
                        credibility=credibility,
                    )
                )
        return claims

    def _collect_extraction(
        self,
        document_id: str,
        row: ChunkRow,
        graph: ExtractedGraph,
        claims: list[ClaimSpec],
        entities: list[EntitySpec],
        nodes: list[GraphNode],
        edges: list[GraphEdge],
    ) -> None:
        type_by_name: dict[str, str] = {}
        for entity in graph.entities:
            entities.append(EntitySpec(name=entity.name, type=entity.type, aliases=entity.aliases))
            type_by_name[entity.name] = entity.type
            nodes.append(
                GraphNode(
                    id=str(entity_id(entity.type, entity.name)),
                    labels=frozenset({_ENTITY_LABEL}),
                    properties={
                        "name": entity.name,
                        "type": entity.type,
                        "source_document_id": document_id,
                    },
                )
            )
        for relation in graph.relations:
            if relation.subject not in type_by_name or relation.object not in type_by_name:
                continue
            edges.append(
                GraphEdge(
                    source_id=str(entity_id(type_by_name[relation.subject], relation.subject)),
                    target_id=str(entity_id(type_by_name[relation.object], relation.object)),
                    type=_safe_edge_type(relation.predicate),
                    properties={"source_document_id": document_id},
                )
            )
        credibility = self._claim_credibility(row)
        for triple in graph.claims:
            claims.append(
                ClaimSpec(
                    chunk_id=row.id,
                    text=triple.text,
                    subject=triple.subject,
                    predicate=triple.predicate,
                    object=triple.object,
                    tags=row.tags,
                    extraction_confidence=row.extraction_confidence,
                    credibility=credibility,
                )
            )

    # --- helpers -------------------------------------------------------------

    async def _require_document(self, scope: ProjectScope, document_id: str) -> DocRow:
        doc = await self._repo.get_document(scope, document_id)
        if doc is None:
            raise DocumentNotFoundError(document_id)
        return doc

    async def _run_status(self, scope: ProjectScope, document_id: str) -> RunStatus:
        status = await self._repo.get_run_status(scope, document_id)
        if status is None:  # pragma: no cover - ensure_run always precedes this
            raise DocumentNotFoundError(document_id)
        return status


def _resolve_status(
    policy: SourcePolicy,
    doc_tags: Sequence[str],
    sensitive: set[str],
    review_if_sensitive: bool,
) -> DocStatus:
    """Map a source policy + proposed tags to a lifecycle status (§4.10.2, D13)."""
    if policy is SourcePolicy.MANUAL:
        return DocStatus.PENDING_APPROVAL
    if policy is SourcePolicy.SOURCE_TAGS:
        return DocStatus.AUTO_APPROVED
    if policy is SourcePolicy.LLM_REVIEW:
        return DocStatus.PENDING_APPROVAL
    # llm: auto-publish unless a sensitive tag was proposed and review_if_sensitive is on.
    if review_if_sensitive and (set(doc_tags) & sensitive):
        return DocStatus.PENDING_APPROVAL
    return DocStatus.AUTO_APPROVED
