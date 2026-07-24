"""Chunk/claim topicalization (FR-1.7). Admin regex rules run first and **win over the LLM**;
the LLM topicalizer is consulted only for text no rule covers. Every chunk ends with ≥1 tag.

A topicalizer failure never blocks ingestion (unlike extraction, FR-1.8): if the model is
unavailable or returns nothing usable, the chunk falls back to the project's default tag. Tags
are always constrained to the project taxonomy — the model can never invent a tag, and it can
never *remove* a rule-assigned (e.g. sensitive) tag, which is the permission-leak guard.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from rsc_brain.config.models import Capability
from rsc_brain.gateway.errors import GatewayError
from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.ingest.prompts import TopicAssignment, load_prompt
from rsc_brain.ingest.types import TopicRule


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
        """Return ≥1 taxonomy tag for ``text``. Rules win; the LLM handles the uncovered rest."""
        rule_tags = tuple(
            dict.fromkeys(
                rule.tag for rule in rules if re.search(rule.pattern, text, re.IGNORECASE)
            )
        )
        if rule_tags:
            # Rules are authoritative and short-circuit the model (§4.6.1): the LLM is never
            # consulted for text a rule already classifies, so a rule always beats the model.
            return rule_tags

        allowed = set(taxonomy)
        try:
            assignment = await self._gateway.complete_structured(
                Capability.TOPICALIZER, self._messages(text, taxonomy), TopicAssignment
            )
        except GatewayError:
            return (default_tag,)
        tags = tuple(dict.fromkeys(tag for tag in assignment.tags if tag in allowed))
        return tags or (default_tag,)

    def _messages(self, text: str, taxonomy: Sequence[str]) -> list[dict[str, str]]:
        system = f"{self._prompt}\n\nProject taxonomy (choose only these slugs): {list(taxonomy)}"
        return [
            {"role": "system", "content": system},
            {"role": "user", "content": text},
        ]
