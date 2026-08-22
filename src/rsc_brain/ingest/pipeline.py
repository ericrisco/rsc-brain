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

import datetime as dt
import uuid
from collections.abc import Callable, Sequence, Set
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, cast

from rsc_brain.config.models import HardwareProfile, KnowledgeConfig
from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.identity.service import DEFAULT_TOPIC_SLUG
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
from rsc_brain.ingest.version_identity import (
    align_occurrences,
    canonical_claim_key,
    normalize_identity,
    sentence_delta,
)
from rsc_brain.knowledge.contradictions import ContradictionResolver
from rsc_brain.knowledge.credibility import (
    authority_for,
    corroborated_authority,
    initial_credibility,
)
from rsc_brain.knowledge.graph_sync import GraphSync
from rsc_brain.ontology.ingest import OntologyIngest
from rsc_brain.review.resolve import REJECTED_TAG
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore, edge_type
from rsc_brain.stores.graph_store import GraphEdge, GraphNode
from rsc_brain.stores.relational.database import session_scope
from rsc_brain.stores.relational.ingest_repository import (
    ChunkRow,
    ClaimIdentityRow,
    ClaimSpec,
    Counters,
    DocRow,
    EntitySpec,
    IngestErrorSpec,
    IngestRepository,
    SourceRow,
)
from rsc_brain.stores.relational.knowledge_store import KnowledgeStore

_ENTITY_LABEL = "Entity"


@dataclass(frozen=True, slots=True)
class PipelineConfig:
    hardware_profile: HardwareProfile = HardwareProfile.WORKSTATION
    sensitivity_threshold: int = 3
    default_tag: str = DEFAULT_TOPIC_SLUG


@dataclass(frozen=True, slots=True)
class VersionBaseline:
    prior: DocRow | None = None
    reuse_chunk_ids: frozenset[str] = frozenset()
    reused_occurrences: dict[str, tuple[str, ...]] | None = None
    extraction_text_by_chunk: dict[str, str] | None = None
    superseded_claim_ids: tuple[str, ...] = ()
    superseded_chunk_ids: tuple[str, ...] = ()
    replacement_candidates: tuple[ClaimIdentityRow, ...] = ()


def default_parser_factory(doc: DocRow) -> DocumentParser:
    """Pick a parser by file type: PDFs → Docling (operator extra), markdown/text → Markdown."""
    suffix = Path(doc.path or doc.logical_id).suffix.lower()
    if suffix == ".pdf":
        return DoclingParser()
    return MarkdownParser()


class DocumentNotFoundError(LookupError):
    """The document does not exist within the caller's project (denied ≡ absent, FR-4.3)."""


class PriorVersionNotProcessedError(RuntimeError):
    """A revision cannot publish before its immediate predecessor establishes the baseline."""


def _decode_instant(value: object) -> dt.datetime | None:
    """A publish draft carries instants as ISO strings; a missing key means the source said nothing.

    Drafts written before validity was carried have no key at all, so absence and null are the same
    answer: unknown validity, never a fabricated one.
    """
    if value is None:
        return None
    return dt.datetime.fromisoformat(str(value))


def _entity_key(type_by_name: dict[str, str], name: str | None) -> str | None:
    """The deterministic identity of a claim endpoint, or None when its type is unknown (R16).

    Same function the graph node id comes from, so a claim and the node it is about carry the same
    value and entity authorization is an equality check rather than a name guess.
    """
    if not name:
        return None
    entity_type = type_by_name.get(name)
    if entity_type is None:
        return None
    return str(entity_id(entity_type, name))


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
        ontology: OntologyIngest | None = None,
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
        # NOT optional: a superseded claim's relation has to stop being current whoever built this
        # pipeline (R27). Built here rather than injected for the reason R18 records.
        self._graph_sync = GraphSync(
            store=KnowledgeStore(repository.sessionmaker), graph=graph_store
        )
        # Optional (SPEC-24): ontology anchoring/merge/relation-check. None (default) OR a project
        # with ontology.enabled=false means every seam here short-circuits — ingest is identical.
        self._ontology = ontology

    def _for(self, scope: ProjectScope) -> ModelGateway:
        """The gateway with accounting bound to this run's project (R12)."""
        return self._gateway.for_project(scope.project_id)

    # --- public entry points -------------------------------------------------

    async def process(self, scope: ProjectScope, document_id: str) -> RunStatus:
        """Run the parse phase; if the source policy auto-approves, continue to publish."""
        doc = await self._require_document(scope, document_id)
        if doc.status == DocStatus.REJECTED.value:
            # T022 re-audit: a document rejected while its job waited in the queue used to be parsed,
            # re-approved and published — the worker undoing an operator's refusal. Since R37 the queue
            # is the normal path, so this is the common case, not an exotic race.
            return await self._run_status(scope, document_id)
        await self._repo.ensure_run(scope, document_id, phase=doc.status)
        parsed = self._parse(doc)
        await self._parse_phase(scope, doc, parsed)

        status = (await self._require_document(scope, document_id)).status
        if status == DocStatus.AUTO_APPROVED.value:
            # T022 re-audit: this used to `set_status(APPROVED)` unconditionally, which is the
            # read-then-write R31 removed from `approve` and `reject` and left here — on the WORKER's
            # path, which R37 made the normal route for an uploaded document. An operator who rejected
            # the document while the job was queued had the refusal silently overwritten, and its claims
            # published. Losing the transition means someone else decided; that is not an error.
            if not await self._repo.transition_status(
                scope,
                document_id,
                expected=[DocStatus.AUTO_APPROVED.value],
                status=DocStatus.APPROVED.value,
            ):
                return await self._run_status(scope, document_id)
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
        await self._require_document(scope, document_id)
        # R31: conditional, so approve and reject racing cannot both win.
        won = await self._repo.transition_status(
            scope,
            document_id,
            expected=[DocStatus.PENDING_APPROVAL.value, DocStatus.AUTO_APPROVED.value],
            status=DocStatus.APPROVED.value,
            approved_by=approver,
            doc_tags=list(tags) if tags is not None else None,
        )
        if not won:
            current = (await self._require_document(scope, document_id)).status
            raise ValueError(f"document {document_id} is not awaiting approval (status={current})")
        await self._repo.propagate_doc_tags(
            scope, document_id, sensitive=await self._sensitive_topics(scope)
        )
        parsed = self._parse(await self._require_document(scope, document_id))
        await self._publish(scope, document_id, parsed)
        return await self._run_status(scope, document_id)

    async def reject(self, scope: ProjectScope, document_id: str, *, reason: str) -> RunStatus:
        """Reject a document: keep the file + reason (auditable), ingest nothing (FR-1.14).

        R31: this used to reject a document in ANY status, so an already-published document could be
        refused while its claims stayed live and recallable — the record said refused and the knowledge
        said accepted, with nothing to reconcile them. Rejecting an already-rejected document is still
        a no-op success, because a retry must be safe.
        """
        await self._require_document(scope, document_id)
        won = await self._repo.transition_status(
            scope,
            document_id,
            expected=[
                DocStatus.RECEIVED.value,
                DocStatus.PARSED.value,
                DocStatus.PENDING_APPROVAL.value,
                DocStatus.AUTO_APPROVED.value,
                DocStatus.REJECTED.value,
            ],
            status=DocStatus.REJECTED.value,
            reject_reason=reason,
        )
        if not won:
            current = (await self._require_document(scope, document_id)).status
            raise ValueError(f"document {document_id} can no longer be rejected (status={current})")
        return await self._run_status(scope, document_id)

    async def recategorize(
        self, scope: ProjectScope, document_id: str, *, tags: Sequence[str]
    ) -> RunStatus:
        """Re-tag an already-published document and repropagate to its chunks (FR-1.15)."""
        doc = await self._require_document(scope, document_id)
        if doc.status != DocStatus.PROCESSED.value:
            raise ValueError(f"document {document_id} is not published (status={doc.status})")
        await self._repo.set_status(scope, document_id, doc.status, doc_tags=list(tags))
        await self._repo.propagate_doc_tags(
            scope, document_id, sensitive=await self._sensitive_topics(scope)
        )
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
            chunk_tags, doc_tags, status, review_chunk_ids = await self._topicalize_and_policy(
                scope, source, chunk_rows
            )
            await self._repo.apply_topics(
                scope,
                doc.id,
                chunk_tags=chunk_tags,
                doc_tags=doc_tags,
                status=status,
                review_chunk_ids=review_chunk_ids,
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

    async def _sensitive_topics(self, scope: ProjectScope) -> frozenset[str]:
        """The project's topics at or above the configured sensitivity threshold (FR-4.14).

        Read from the project's own taxonomy rather than from configuration alone, because the
        threshold is a number and the topics it selects are per-project data.
        """
        topics = await self._repo.list_topics(scope)
        return frozenset(
            slug
            for slug, sensitivity in topics
            if sensitivity >= self._config.sensitivity_threshold
        )

    async def _topicalize_and_policy(
        self, scope: ProjectScope, source: SourceRow, chunk_rows: Sequence[ChunkRow]
    ) -> tuple[dict[str, tuple[str, ...]], tuple[str, ...], str, tuple[str, ...]]:
        topics = await self._repo.list_topics(scope)
        taxonomy = [slug for slug, _ in topics]
        sensitive = {slug for slug, sens in topics if sens >= self._config.sensitivity_threshold}
        rules = await self._repo.get_topic_rules(scope)
        default_tag = taxonomy[0] if taxonomy else self._config.default_tag
        policy = SourcePolicy(source.policy)
        topicalizer = Topicalizer(self._for(scope))

        chunk_tags: dict[str, tuple[str, ...]] = {}
        review_chunk_ids: list[str] = []
        proposed: set[str] = set(source.default_tags)
        for row in chunk_rows:
            if row.needs_review:
                chunk_tags[row.id] = row.tags  # reserved needs_review tag, kept as-is
                continue
            decision = await topicalizer.classify(
                row.text,
                taxonomy=taxonomy,
                rules=rules,
                default_tag=default_tag,
                floor_tags=source.default_tags,
            )
            tags = decision.tags
            if policy not in {SourcePolicy.MANUAL, SourcePolicy.SOURCE_TAGS}:
                proposed.update(tags)
            # A prompt-like chunk is quarantined under every source policy. By contrast, an
            # unavailable/empty topicalizer only creates uncertainty when policy delegates
            # classification to the model. MANUAL/SOURCE_TAGS already have a complete,
            # deterministic source floor, so model absence cannot weaken their permissions.
            model_owned_policy = policy in {SourcePolicy.LLM, SourcePolicy.LLM_REVIEW}
            if decision.requires_review and (
                decision.reason == "prompt_injection" or model_owned_policy
            ):
                review_chunk_ids.append(row.id)
            # AUDIT-141: under MANUAL and SOURCE_TAGS the chunk carries the SOURCE's tags, not the
            # topicalizer's. This line used to be `tags or (default_tag,)` under every policy, and
            # `Topicalizer.classify` returns `floor | model_tags` — the floor is a lower bound, so a
            # model could only ever ADD topics. The authorization filter matches on CHUNK tags
            # (`recall/permissions.py`) and visibility is any-match, so one added topic is one more
            # audience. Measured on the corpus: source `legal-drive` declaring `{legal}` produced a
            # document row `{legal}` and a chunk row `{legal, corp, delivery}`, and a principal
            # holding `corp, delivery` read the contract. `legal` is sensitivity 2, so the FR-4.14
            # veto never fired — the topics a model adds to widen an audience are, by their nature,
            # the unremarkable ones.
            #
            # These two policies exist so that no model decides classification; `credibility.py`
            # prices `source_tags` at 0.85 for that reason. The topicalizer is still called, because
            # the prompt-injection quarantine above is a REVIEW decision and belongs to every policy.
            # What changes is that its opinion no longer reaches the field permissions are read from.
            if policy in {SourcePolicy.MANUAL, SourcePolicy.SOURCE_TAGS}:
                chunk_tags[row.id] = tuple(source.default_tags) or (default_tag,)
            else:
                chunk_tags[row.id] = tags or (default_tag,)

        if policy in {SourcePolicy.MANUAL, SourcePolicy.SOURCE_TAGS}:
            doc_tags = tuple(source.default_tags)
        else:
            doc_tags = tuple(sorted(proposed))
        status = _resolve_status(policy, doc_tags, sensitive, source.review_if_sensitive)
        if review_chunk_ids:
            status = DocStatus.PENDING_APPROVAL
        return chunk_tags, doc_tags, status.value, tuple(review_chunk_ids)

    # --- publish phase -------------------------------------------------------

    async def _publish(self, scope: ProjectScope, document_id: str, parsed: ParsedDocument) -> None:
        if await self._repo.is_stage_complete(scope, document_id, PipelineStage.PERSIST):
            await self._repo.set_status(scope, document_id, DocStatus.PROCESSED.value)
            return
        existing_draft = await self._repo.get_publish_draft(scope, document_id)
        if existing_draft is not None:
            await self._apply_publish_draft(scope, document_id, existing_draft)
            await self._after_publish(scope, document_id)
            return
        chunk_rows = await self._repo.load_chunks(scope, document_id)
        # A new version only re-materialises what changed: unchanged chunks (text seen in the prior
        # version) are neither re-embedded nor re-extracted, so their prior claims keep serving with
        # their id + credibility intact (D6, AC#2). The prior version is superseded afterwards.
        baseline = await self._version_baseline(scope, document_id, chunk_rows)
        reuse_chunk_ids = baseline.reuse_chunk_ids
        embeddable = [
            c
            for c in chunk_rows
            if not c.needs_review
            and REJECTED_TAG
            not in c.tags  # R26: a refused chunk stays out of the index on redo too
            and c.text.strip()
            and c.id not in reuse_chunk_ids
        ]
        embeddings = await self._embed(scope, embeddable)

        # R20/R21: credibility is derived from the document's real provenance and from how many
        # independent sources already assert the same thing — not from chunk layout with a hardcoded
        # count of one. Both are resolved ONCE per document, before any claim is built.
        document = await self._require_document(scope, document_id)
        source = await self._resolve_source(scope, document)
        corroboration = await self._repo.count_independent_sources(scope, document_id)

        claims: list[ClaimSpec] = list(
            self._table_claims(
                parsed,
                chunk_rows,
                reuse_chunk_ids,
                source=source,
                n_independent_sources=corroboration,
            )
        )
        entities: list[EntitySpec] = []
        errors: list[IngestErrorSpec] = []
        nodes: list[GraphNode] = []
        edges: list[GraphEdge] = []
        discarded = 0

        extractor = CascadeExtractor(self._for(scope))

        # SPEC-24 seam: load the active ontology once (None ⇒ layer off ⇒ no relation check below).
        ontology_index = await self._ontology.index_for(scope) if self._ontology else None
        relation_decider = (
            self._ontology.relation_decider(
                ontology_index, await self._ontology.settings_for(scope)
            )
            if self._ontology and ontology_index is not None
            else None
        )

        for row in chunk_rows:
            if row.kind != ChunkKind.PROSE.value or row.needs_review:
                continue
            if REJECTED_TAG in row.tags:
                continue  # R26: refused content is not extracted from, however often publish reruns
            if row.id in reuse_chunk_ids:
                continue  # unchanged prose: skip extraction (0 LLM calls); prior claim stays live
            extraction_text = (baseline.extraction_text_by_chunk or {}).get(row.id, row.text)
            if not extraction_text.strip():
                continue
            try:
                graph = await extractor.extract(extraction_text)
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
            self._collect_extraction(
                document_id,
                row,
                graph,
                claims,
                entities,
                nodes,
                edges,
                errors,
                relation_decider,
                source=source,
                n_independent_sources=corroboration,
            )

        claims, duplicate_occurrences = self._canonicalize_new_claims(
            claims, {chunk.id: chunk.text for chunk in chunk_rows}
        )
        reused_occurrences = {
            key: list(value) for key, value in (baseline.reused_occurrences or {}).items()
        }
        for chunk_id, claim_ids in duplicate_occurrences.items():
            reused_occurrences.setdefault(chunk_id, []).extend(claim_ids)
        baseline = replace(
            baseline,
            reused_occurrences={
                key: tuple(dict.fromkeys(value)) for key, value in reused_occurrences.items()
            },
        )
        supersessions = self._replacement_lineage(baseline.replacement_candidates, claims)
        for previous, replacement in supersessions:
            nodes.extend(
                [
                    GraphNode(
                        id=previous,
                        labels=frozenset({"Claim"}),
                        properties={"kind": "claim"},
                    ),
                    GraphNode(
                        id=replacement,
                        labels=frozenset({"Claim"}),
                        properties={"kind": "claim"},
                    ),
                ]
            )
            edges.append(GraphEdge(source_id=previous, target_id=replacement, type="SUPERSEDED_BY"))
        claims = await self._embed_claims(scope, claims)
        counters = Counters(claims_generated=len(claims), discarded_chunks=discarded)
        publish_at = dt.datetime.now(dt.UTC)
        draft = self._encode_publish_draft(
            embeddings=embeddings,
            claims=claims,
            entities=entities,
            errors=errors,
            counters=counters,
            nodes=nodes,
            edges=edges,
            baseline=baseline,
            supersessions=supersessions,
            publish_at=publish_at,
        )
        # The draft commits BEFORE any publication mutation. A rollback therefore keeps the exact
        # model output, UUIDs, vectors, timestamp and counters needed for a byte-for-byte retry.
        draft = await self._repo.save_publish_draft(scope, document_id, draft)
        await self._apply_publish_draft(scope, document_id, draft)
        await self._after_publish(scope, document_id)

    async def _after_publish(self, scope: ProjectScope, document_id: str) -> None:
        await self._detect_contradictions_on_ingest(scope, document_id)
        # SPEC-24 FR-17.2/17.3: anchor the newly-written entities to the ontology and propose merges
        # for those sharing an IRI. No-op when the layer is off (index is None), so recall never
        # pays for it — the anchoring latency lives entirely inside this ingest job (FR-17.8).
        if self._ontology is not None:
            ontology_index = await self._ontology.index_for(scope)
            await self._ontology.anchor_and_merge(scope, ontology_index)

    @staticmethod
    def _encode_publish_draft(
        *,
        embeddings: dict[str, list[float]],
        claims: Sequence[ClaimSpec],
        entities: Sequence[EntitySpec],
        errors: Sequence[IngestErrorSpec],
        counters: Counters,
        nodes: Sequence[GraphNode],
        edges: Sequence[GraphEdge],
        baseline: VersionBaseline,
        supersessions: Sequence[tuple[str, str]],
        publish_at: dt.datetime,
    ) -> dict[str, object]:
        """JSON-safe, versioned publication envelope; the database is its durability boundary."""

        return {
            "version": 1,
            "publish_at": publish_at.isoformat(),
            "embeddings": embeddings,
            "claims": [
                {
                    "id": claim.id,
                    "chunk_id": claim.chunk_id,
                    "text": claim.text,
                    "subject": claim.subject,
                    "predicate": claim.predicate,
                    "object": claim.object,
                    # The source-stated validity has to survive the durability boundary too: a
                    # draft that drops it publishes an undated claim on the retry path only.
                    "valid_from": (
                        claim.valid_from.isoformat() if claim.valid_from is not None else None
                    ),
                    "valid_to": claim.valid_to.isoformat() if claim.valid_to is not None else None,
                    "subject_entity_key": claim.subject_entity_key,
                    "object_entity_key": claim.object_entity_key,
                    "tags": list(claim.tags),
                    "extraction_confidence": claim.extraction_confidence,
                    "credibility": claim.credibility,
                    "embedding": list(claim.embedding) if claim.embedding is not None else None,
                }
                for claim in claims
            ],
            "entities": [
                {"name": entity.name, "type": entity.type, "aliases": list(entity.aliases)}
                for entity in entities
            ],
            "errors": [
                {"chunk_ref": error.chunk_ref, "stage": error.stage, "error": error.error}
                for error in errors
            ],
            "counters": {
                "chunks_created": counters.chunks_created,
                "claims_generated": counters.claims_generated,
                "tables_converted": counters.tables_converted,
                "tables_needs_review": counters.tables_needs_review,
                "discarded_chunks": counters.discarded_chunks,
            },
            "nodes": [
                {
                    "id": node.id,
                    "labels": sorted(node.labels),
                    "properties": dict(node.properties),
                }
                for node in nodes
            ],
            "edges": [
                {
                    "source_id": edge.source_id,
                    "target_id": edge.target_id,
                    "type": edge.type,
                    "properties": dict(edge.properties),
                }
                for edge in edges
            ],
            "reused_occurrences": {
                key: list(value) for key, value in (baseline.reused_occurrences or {}).items()
            },
            "superseded_claim_ids": list(baseline.superseded_claim_ids),
            "superseded_chunk_ids": list(baseline.superseded_chunk_ids),
            "supersessions": [list(pair) for pair in supersessions],
        }

    async def _apply_publish_draft(
        self, scope: ProjectScope, document_id: str, draft: dict[str, object]
    ) -> None:
        """Apply every relational, AGE and lifecycle effect in one transaction."""

        payload = cast(dict[str, Any], draft)
        claims = [
            ClaimSpec(
                **{
                    **item,
                    "tags": tuple(item.get("tags") or ()),
                    "valid_from": _decode_instant(item.get("valid_from")),
                    "valid_to": _decode_instant(item.get("valid_to")),
                    "embedding": (
                        tuple(item["embedding"]) if item.get("embedding") is not None else None
                    ),
                }
            )
            for item in cast(list[dict[str, Any]], payload["claims"])
        ]
        entities = [
            EntitySpec(
                name=item["name"], type=item["type"], aliases=tuple(item.get("aliases") or ())
            )
            for item in cast(list[dict[str, Any]], payload["entities"])
        ]
        errors = [
            IngestErrorSpec(
                chunk_ref=item.get("chunk_ref"), stage=item["stage"], error=item["error"]
            )
            for item in cast(list[dict[str, Any]], payload["errors"])
        ]
        counters = Counters(**cast(dict[str, int], payload["counters"]))
        nodes = [
            GraphNode(
                id=item["id"],
                labels=frozenset(item.get("labels") or ()),
                properties=dict(item.get("properties") or {}),
            )
            for item in cast(list[dict[str, Any]], payload["nodes"])
        ]
        edges = [
            GraphEdge(
                source_id=item["source_id"],
                target_id=item["target_id"],
                type=item["type"],
                properties=dict(item.get("properties") or {}),
            )
            for item in cast(list[dict[str, Any]], payload["edges"])
        ]
        superseded_claim_ids = tuple(cast(list[str], payload["superseded_claim_ids"]))
        superseded_chunk_ids = tuple(cast(list[str], payload["superseded_chunk_ids"]))
        supersessions = [
            (str(pair[0]), str(pair[1])) for pair in cast(list[list[str]], payload["supersessions"])
        ]
        embeddings = {
            str(key): [float(value) for value in values]
            for key, values in cast(dict[str, list[float]], payload["embeddings"]).items()
        }
        reused = {
            str(key): tuple(str(value) for value in values)
            for key, values in cast(dict[str, list[str]], payload["reused_occurrences"]).items()
        }
        publish_at = dt.datetime.fromisoformat(str(payload["publish_at"]))

        async with session_scope(self._repo.sessionmaker) as unit:
            await self._repo.record_publish(
                scope,
                document_id,
                embeddings=embeddings,
                claims=claims,
                entities=entities,
                errors=errors,
                counters=counters,
                reused_occurrences=reused,
                superseded_claim_ids=superseded_claim_ids,
                superseded_chunk_ids=superseded_chunk_ids,
                supersessions=supersessions,
                publish_at=publish_at,
                session=unit,
            )
            await self._graph.create_graph(scope, session=unit)
            if nodes:
                await self._graph.upsert_nodes(scope, nodes, session=unit)
            if edges:
                await self._graph.upsert_edges(scope, edges, session=unit)
            if superseded_claim_ids:
                await self._graph_sync.retire_claims(scope, superseded_claim_ids, session=unit)
            await self._repo.finalize_publish(unit, scope, document_id)

    async def _version_baseline(
        self, scope: ProjectScope, document_id: str, current_chunks: Sequence[ChunkRow]
    ) -> VersionBaseline:
        """Build the ordered claim-level delta against the immediate published predecessor."""
        doc = await self._require_document(scope, document_id)
        if doc.version <= 1:
            return VersionBaseline()
        prior = await self._repo.immediate_prior_document(scope, doc.logical_id, doc.version)
        if prior is None or prior.status != DocStatus.PROCESSED.value:
            status = "missing" if prior is None else prior.status
            raise PriorVersionNotProcessedError(
                f"document {document_id} version {doc.version} cannot publish before "
                f"version {doc.version - 1} is processed (status={status})"
            )
        prior_chunks = await self._repo.load_chunks(scope, prior.id)
        claims_by_prior_chunk = await self._repo.active_claims_by_chunk(scope, prior.id)
        reused: dict[str, tuple[str, ...]] = {}
        exact_chunk_ids: set[str] = set()
        extraction_texts: dict[str, str] = {}
        closed: list[str] = []
        superseded_chunks: list[str] = []
        replacement_candidates: list[ClaimIdentityRow] = []
        for match in align_occurrences(
            [chunk.text for chunk in prior_chunks], [chunk.text for chunk in current_chunks]
        ):
            if match.prior_index is None:
                continue
            prior_chunk = prior_chunks[match.prior_index]
            prior_claims = claims_by_prior_chunk.get(prior_chunk.id, ())
            if match.current_index is None:
                superseded_chunks.append(prior_chunk.id)
                closed.extend(claim.id for claim in prior_claims)
                replacement_candidates.extend(prior_claims)
                continue
            current_chunk = current_chunks[match.current_index]
            if match.exact:
                exact_chunk_ids.add(current_chunk.id)
                if prior_claims:
                    reused[current_chunk.id] = tuple(claim.id for claim in prior_claims)
                continue

            superseded_chunks.append(prior_chunk.id)
            delta = sentence_delta(prior_chunk.text, current_chunk.text)
            extraction_texts[current_chunk.id] = delta.extraction_text
            unchanged = tuple(normalize_identity(sentence) for sentence in delta.unchanged)
            kept = tuple(
                claim
                for claim in prior_claims
                if any(
                    normalize_identity(claim.text) in sentence
                    or sentence in normalize_identity(claim.text)
                    for sentence in unchanged
                )
            )
            if kept:
                reused[current_chunk.id] = tuple(claim.id for claim in kept)
            removed = [claim for claim in prior_claims if claim not in kept]
            closed.extend(claim.id for claim in removed)
            replacement_candidates.extend(removed)
        reused_claim_ids = {claim_id for claim_ids in reused.values() for claim_id in claim_ids}
        closed_ids = tuple(
            claim_id for claim_id in dict.fromkeys(closed) if claim_id not in reused_claim_ids
        )
        replacement_candidates = [
            claim for claim in replacement_candidates if claim.id in closed_ids
        ]
        return VersionBaseline(
            prior=prior,
            reuse_chunk_ids=frozenset(exact_chunk_ids),
            reused_occurrences=reused,
            extraction_text_by_chunk=extraction_texts,
            superseded_claim_ids=closed_ids,
            superseded_chunk_ids=tuple(dict.fromkeys(superseded_chunks)),
            replacement_candidates=tuple(replacement_candidates),
        )

    @staticmethod
    def _canonicalize_new_claims(
        claims: Sequence[ClaimSpec], chunk_texts: dict[str, str]
    ) -> tuple[list[ClaimSpec], dict[str, list[str]]]:
        """Collapse repeated content, retaining every concrete chunk as an occurrence.

        The source text participates only in this within-publish collapse: a weak extractor can emit
        the same generic triple for unrelated chunks, which is not evidence that those assertions are
        one identity. Identical chunk content plus an identical claim key is unambiguous.
        """

        canonical: dict[tuple[str, ...], ClaimSpec] = {}
        extra_occurrences: dict[str, list[str]] = {}
        for candidate in claims:
            key = (
                *canonical_claim_key(
                    candidate.text, candidate.subject, candidate.predicate, candidate.object
                ),
                "source",
                normalize_identity(chunk_texts.get(candidate.chunk_id, "")),
            )
            existing = canonical.get(key)
            if existing is None:
                canonical[key] = replace(candidate, id=candidate.id or str(uuid.uuid4()))
                continue
            if candidate.chunk_id != existing.chunk_id and existing.id is not None:
                extra_occurrences.setdefault(candidate.chunk_id, []).append(existing.id)
        return list(canonical.values()), extra_occurrences

    @staticmethod
    def _replacement_lineage(
        previous: Sequence[ClaimIdentityRow], replacements: Sequence[ClaimSpec]
    ) -> list[tuple[str, str]]:
        """Infer only unambiguous same-subject+predicate replacements, previous → replacement."""

        old_by_slot: dict[tuple[str, str], list[ClaimIdentityRow]] = {}
        new_by_slot: dict[tuple[str, str], list[ClaimSpec]] = {}
        for old_claim in previous:
            if old_claim.subject and old_claim.predicate:
                old_by_slot.setdefault(
                    (
                        normalize_identity(old_claim.subject),
                        normalize_identity(old_claim.predicate),
                    ),
                    [],
                ).append(old_claim)
        for new_claim in replacements:
            if new_claim.subject and new_claim.predicate and new_claim.id:
                new_by_slot.setdefault(
                    (
                        normalize_identity(new_claim.subject),
                        normalize_identity(new_claim.predicate),
                    ),
                    [],
                ).append(new_claim)
        lineage: list[tuple[str, str]] = []
        for slot, old_claims in old_by_slot.items():
            new_claims = new_by_slot.get(slot, [])
            if len(old_claims) == len(new_claims) == 1:
                replacement_id = new_claims[0].id
                if replacement_id is not None:
                    lineage.append((old_claims[0].id, replacement_id))
        return lineage

    async def _detect_contradictions_on_ingest(self, scope: ProjectScope, document_id: str) -> None:
        """On-ingest contradiction detection over the document's new claims (SPEC-08 FR-5.2).
        No-op unless a resolver is configured (opt-in)."""
        if self._resolver is None:
            return
        await self._resolver.resolve_document(scope, document_id)

    def _claim_credibility(
        self, row: ChunkRow, *, source: SourceRow | None = None, n_independent_sources: int = 1
    ) -> float:
        """cred0 (FR-5.1) from the chunk's layout AND the document's real provenance.

        R20: this used to read ``row.kind`` only — a table row was authoritative, a scanned page was
        not — so an unvetted upload and a manually curated source produced the same number and the
        ``Source`` the document actually came from never participated.

        R21: ``n_independent_sources`` used to be hardcoded to 1, so agreement between independent
        documents never raised credibility. The caller counts it; this function only uses it.
        """
        if row.kind == ChunkKind.TABLE_ROW.value:
            source_kind = "table"
        elif row.extraction_confidence is not None and row.extraction_confidence < 1.0:
            source_kind = "low_quality_ocr"
        else:
            source_kind = "official_prose"
        layout_authority = authority_for(
            source_kind,
            table=self._knowledge.authority_by_source,
            default=self._knowledge.default_authority,
        )
        return initial_credibility(
            authority=corroborated_authority(
                layout_authority,
                source.policy if source is not None else None,
                default=self._knowledge.default_authority,
            ),
            extraction_confidence=row.extraction_confidence,
            n_independent_sources=n_independent_sources,
            freshness=1.0,
        )

    async def _embed(
        self, scope: ProjectScope, chunks: Sequence[ChunkRow]
    ) -> dict[str, list[float]]:
        if not chunks:
            return {}
        vectors = await self._for(scope).embed([c.text for c in chunks])
        return {chunk.id: vector for chunk, vector in zip(chunks, vectors, strict=True)}

    async def _embed_claims(
        self, scope: ProjectScope, claims: Sequence[ClaimSpec]
    ) -> list[ClaimSpec]:
        """Attach a vector to every claim, in one batched call (R18).

        Chunk embeddings are not usable here: a chunk holding both the current and the retired
        sentence has one vector for both, which is the same conflation R22 is about. Contradiction
        detection compares assertions, so it needs a vector per assertion. Costs one embedding per
        claim; the gateway's cache absorbs re-ingests of unchanged text.
        """
        if not claims:
            return list(claims)
        vectors = await self._for(scope).embed([c.text for c in claims])
        return [
            replace(claim, embedding=tuple(vector))
            for claim, vector in zip(claims, vectors, strict=True)
        ]

    def _table_claims(
        self,
        parsed: ParsedDocument,
        chunk_rows: Sequence[ChunkRow],
        reuse_chunk_ids: Set[str] | None = None,
        *,
        source: SourceRow | None = None,
        n_independent_sources: int = 1,
    ) -> list[ClaimSpec]:
        """Recover the deterministic table-row claims and bind them to their persisted chunk by
        text (table_row text is unique per row, so the mapping is unambiguous). Exactly aligned rows
        are skipped by chunk id — not by a text set, which loses duplicate occurrences."""
        unchanged = reuse_chunk_ids or set()
        by_text: dict[str, ChunkRow] = {
            c.text: c for c in chunk_rows if c.kind == ChunkKind.TABLE_ROW.value
        }
        specs, _ = self._build_chunks(parsed)
        claims: list[ClaimSpec] = []
        for spec in specs:
            if spec.kind is not ChunkKind.TABLE_ROW or spec.needs_review or not spec.claims:
                continue
            row = by_text.get(spec.text)
            if row is None:
                continue
            if row.id in unchanged:
                continue
            credibility = self._claim_credibility(
                row, source=source, n_independent_sources=n_independent_sources
            )
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
        errors: list[IngestErrorSpec],
        relation_decider: Callable[[str, str, str], str] | None = None,
        *,
        source: SourceRow | None = None,
        n_independent_sources: int = 1,
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
            # SPEC-24 FR-17.4: apply the ontology domain/range policy. `drop` skips the edge and
            # logs it; `flag` keeps the edge but records a needs_review error; `keep` (and the
            # off-by-default path where decider is None) passes untouched.
            properties: dict[str, object] = {"source_document_id": document_id}
            if relation_decider is not None:
                verdict = relation_decider(relation.predicate, relation.subject, relation.object)
                if verdict == "drop":
                    errors.append(
                        IngestErrorSpec(
                            chunk_ref=row.id,
                            stage="ontology_relation_check",
                            error=f"domain_range_violation:dropped:{relation.predicate}",
                        )
                    )
                    continue
                if verdict == "flag":
                    properties["needs_review"] = True
                    errors.append(
                        IngestErrorSpec(
                            chunk_ref=row.id,
                            stage="ontology_relation_check",
                            error=f"domain_range_violation:needs_review:{relation.predicate}",
                        )
                    )
            edges.append(
                GraphEdge(
                    source_id=str(entity_id(type_by_name[relation.subject], relation.subject)),
                    target_id=str(entity_id(type_by_name[relation.object], relation.object)),
                    type=edge_type(relation.predicate),
                    properties=properties,
                )
            )
        credibility = self._claim_credibility(
            row, source=source, n_independent_sources=n_independent_sources
        )
        for triple in graph.claims:
            for diagnostic in triple.temporal_diagnostics:
                errors.append(
                    IngestErrorSpec(
                        chunk_ref=row.id,
                        stage="temporal_validity",
                        error=f"{diagnostic.field}:{diagnostic.message}",
                    )
                )
            claims.append(
                ClaimSpec(
                    chunk_id=row.id,
                    text=triple.text,
                    subject=triple.subject,
                    predicate=triple.predicate,
                    object=triple.object,
                    valid_from=triple.valid_from,
                    valid_to=triple.valid_to,
                    # The extractor knew each endpoint's TYPE, so the claim can carry the same
                    # deterministic identity as the graph node instead of only a name (R16).
                    subject_entity_key=_entity_key(type_by_name, triple.subject),
                    object_entity_key=_entity_key(type_by_name, triple.object),
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
