"""Rule-first topicalization with immutable deterministic floors and fail-closed review."""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass

from rsc_brain.config.models import Capability
from rsc_brain.gateway.errors import GatewayError
from rsc_brain.gateway.messages import untrusted_data_message
from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.ingest.prompt_injection import detect_prompt_injection
from rsc_brain.ingest.prompts import TopicAssignment, load_prompt
from rsc_brain.ingest.types import TopicRule


@dataclass(frozen=True, slots=True)
class TopicDecision:
    tags: tuple[str, ...]
    requires_review: bool = False
    reason: str | None = None


class Topicalizer:
    """Rule-first, LLM-second topic assignment constrained to the project taxonomy."""

    def __init__(self, gateway: ModelGateway) -> None:
        self._gateway = gateway
        self._prompt = load_prompt("topicalizer")

    async def tag(
        self,
        text: str,
        *,
        taxonomy: Sequence[str],
        rules: Sequence[TopicRule],
        default_tag: str,
    ) -> tuple[str, ...]:
        """Compatibility helper returning only tags; production policy consumes ``classify``."""

        decision = await self.classify(
            text,
            taxonomy=taxonomy,
            rules=rules,
            default_tag=default_tag,
            floor_tags=(),
        )
        return decision.tags

    async def classify(
        self,
        text: str,
        *,
        taxonomy: Sequence[str],
        rules: Sequence[TopicRule],
        default_tag: str,
        floor_tags: Sequence[str],
    ) -> TopicDecision:
        """Return tags plus whether this chunk must remain outside publication pending review."""

        rule_tags = tuple(
            dict.fromkeys(
                rule.tag for rule in rules if re.search(rule.pattern, text, re.IGNORECASE)
            )
        )
        floor = tuple(dict.fromkeys([*floor_tags, *rule_tags]))
        if detect_prompt_injection(text) is not None:
            return TopicDecision(floor or (default_tag,), True, "prompt_injection")
        if rule_tags:
            return TopicDecision(floor)

        allowed = set(taxonomy)
        try:
            assignment = await self._gateway.complete_structured(
                Capability.TOPICALIZER, self._messages(text, taxonomy), TopicAssignment
            )
        except GatewayError:
            return TopicDecision(
                tuple(dict.fromkeys([*floor, default_tag])), True, "provider_failure"
            )
        tags = tuple(dict.fromkeys(tag for tag in assignment.tags if tag in allowed))
        if not tags:
            return TopicDecision(
                tuple(dict.fromkeys([*floor, default_tag])), True, "empty_or_invalid"
            )
        return TopicDecision(tuple(dict.fromkeys([*floor, *tags])))

    def _messages(self, text: str, taxonomy: Sequence[str]) -> list[dict[str, str]]:
        return [
            {"role": "system", "content": self._prompt},
            untrusted_data_message("topicalize_chunk", content=text, taxonomy=list(taxonomy)),
        ]
