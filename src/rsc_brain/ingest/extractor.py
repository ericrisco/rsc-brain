"""Cascade graph extraction over a prose chunk (FR-1.8): entities → relations → claims, each
via ``ModelGateway.complete_structured`` with the versioned SPEC-02 prompts.

If any step's structured output cannot be validated/repaired, the gateway raises a typed
:class:`GatewayError`; this module converts it into :class:`ExtractionDiscarded` so the pipeline
records the failure in ``ingest_errors`` (document, chunk, stage) and **contributes nothing from
this chunk to the graph**. The chunk itself still exists for vector recall — only its graph
contribution is dropped. Writing unvalidated output to the graph is a PR auto-reject (§4.7.3).
"""

from __future__ import annotations

from rsc_brain.config.models import Capability
from rsc_brain.gateway.errors import GatewayError
from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.gateway.options import GenerationOptions
from rsc_brain.ingest.prompts import (
    ClaimExtraction,
    EntityExtraction,
    RelationExtraction,
    load_prompt,
)
from rsc_brain.ingest.types import (
    ClaimTriple,
    ExtractedEntity,
    ExtractedGraph,
    ExtractedRelation,
)


class ExtractionDiscarded(Exception):
    """A chunk's extraction failed after repair/fallback; its graph contribution is discarded."""

    def __init__(self, stage: str, correlation_id: str | None = None) -> None:
        self.stage = stage
        self.correlation_id = correlation_id
        super().__init__(f"extraction discarded at stage '{stage}'")


class CascadeExtractor:
    """Runs the three-step cascade for a single prose chunk."""

    def __init__(self, gateway: ModelGateway) -> None:
        self._gateway = gateway
        self._entities_prompt = load_prompt("extractor_entities")
        self._relations_prompt = load_prompt("extractor_relations")
        self._claims_prompt = load_prompt("extractor_claims")

    async def extract(
        self, text: str, *, options: GenerationOptions | None = None
    ) -> ExtractedGraph:
        entities = await self._entities(text, options)
        relations = await self._relations(text, [e.name for e in entities], options)
        claims = await self._claims(text, options)
        return ExtractedGraph(
            entities=tuple(entities), relations=tuple(relations), claims=tuple(claims)
        )

    async def _entities(
        self, text: str, options: GenerationOptions | None
    ) -> list[ExtractedEntity]:
        try:
            result = await self._gateway.complete_structured(
                Capability.EXTRACTOR,
                _messages(self._entities_prompt, text),
                EntityExtraction,
                options,
            )
        except GatewayError as exc:
            raise ExtractionDiscarded("entities", exc.correlation_id) from exc
        return [
            ExtractedEntity(name=e.name, type=e.type, aliases=tuple(e.aliases))
            for e in result.entities
        ]

    async def _relations(
        self, text: str, entity_names: list[str], options: GenerationOptions | None
    ) -> list[ExtractedRelation]:
        user = f"{text}\n\nEntities (from step 1): {entity_names}"
        try:
            result = await self._gateway.complete_structured(
                Capability.EXTRACTOR,
                _messages(self._relations_prompt, user),
                RelationExtraction,
                options,
            )
        except GatewayError as exc:
            raise ExtractionDiscarded("relations", exc.correlation_id) from exc
        return [
            ExtractedRelation(subject=r.subject, predicate=r.predicate, object=r.object)
            for r in result.relations
        ]

    async def _claims(self, text: str, options: GenerationOptions | None) -> list[ClaimTriple]:
        try:
            result = await self._gateway.complete_structured(
                Capability.EXTRACTOR,
                _messages(self._claims_prompt, text),
                ClaimExtraction,
                options,
            )
        except GatewayError as exc:
            raise ExtractionDiscarded("claims", exc.correlation_id) from exc
        return [
            ClaimTriple(text=c.text, subject=c.subject, predicate=c.predicate, object=c.object)
            for c in result.claims
        ]


def _messages(prompt: str, content: str) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": prompt},
        {"role": "user", "content": content},
    ]
