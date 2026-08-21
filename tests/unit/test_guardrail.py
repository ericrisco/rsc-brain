"""AUDIT-016: the final-context classifier may remove data but never grant authority."""

from __future__ import annotations

from collections.abc import Sequence

from rsc_brain.config.models import Capability
from rsc_brain.mcp.tools import RecallFragment
from rsc_brain.recall.guardrail import GatewayTopicClassifier, screen_fragments


class FakeBatchClassifier:
    def __init__(
        self, verdicts: Sequence[str | None] = (), *, error: Exception | None = None
    ) -> None:
        self._verdicts = list(verdicts)
        self._error = error
        self.calls: list[tuple[list[str], list[str]]] = []

    async def classify_many(
        self, texts: Sequence[str], candidate_topics: Sequence[str]
    ) -> Sequence[str | None]:
        self.calls.append((list(texts), list(candidate_topics)))
        if self._error is not None:
            raise self._error
        return self._verdicts


class RecordingGateway:
    def __init__(self, topics: list[str | None]) -> None:
        self.topics = topics
        self.calls: list[tuple[Capability, list[object], str]] = []

    async def complete_structured(
        self, capability: Capability, messages: list[object], schema: type[object]
    ) -> object:
        self.calls.append((capability, messages, schema.__name__))
        return schema.model_validate({"topics": self.topics})  # type: ignore[attr-defined]


def _fragment(text: str, claim_id: str) -> RecallFragment:
    return RecallFragment(text=text, claim_ids=[claim_id], document="d", credibility=0.6)


async def test_drops_only_the_mislabeled_fragment() -> None:
    good = _fragment("hr policy text", "c1")
    leaked = _fragment("salary figures", "c2")
    classifier = FakeBatchClassifier(["hr", "finance"])

    result = await screen_fragments(
        [good, leaked],
        allowed_topics=frozenset({"hr"}),
        project_topics=["hr", "finance"],
        classifier=classifier,
    )

    assert [f.claim_ids for f in result.kept] == [["c1"]]
    assert [f.claim_ids for f in result.dropped] == [["c2"]]
    assert result.flagged_claim_ids == ["c2"]
    assert result.mislabeled_count == 1
    assert result.inconclusive_count == 0
    assert not result.clean


async def test_none_missing_unknown_and_exception_are_fail_secure() -> None:
    fragments = [_fragment(name, f"c{i}") for i, name in enumerate(["none", "allowed", "missing"])]
    partial = await screen_fragments(
        fragments,
        allowed_topics=frozenset({"hr"}),
        project_topics=["finance", "hr"],
        classifier=FakeBatchClassifier([None, "hr"]),
    )
    assert [item.text for item in partial.kept] == ["allowed"]
    assert [item.text for item in partial.dropped] == ["none", "missing"]
    assert partial.inconclusive_count == 2

    unknown = await screen_fragments(
        [_fragment("unknown", "c3")],
        allowed_topics=frozenset({"hr"}),
        project_topics=["hr"],
        classifier=FakeBatchClassifier(["invented"]),
    )
    assert unknown.kept == [] and unknown.inconclusive_count == 1

    failed = await screen_fragments(
        [_fragment("provider failure", "c4")],
        allowed_topics=frozenset({"hr"}),
        project_topics=["hr"],
        classifier=FakeBatchClassifier(error=TimeoutError()),
    )
    assert failed.kept == [] and failed.inconclusive_count == 1


async def test_empty_taxonomy_blocks_without_calling_the_model() -> None:
    classifier = FakeBatchClassifier(["hr"])
    result = await screen_fragments(
        [_fragment("text", "c1")],
        allowed_topics=frozenset({"hr"}),
        project_topics=[],
        classifier=classifier,
    )
    assert result.kept == [] and result.inconclusive_count == 1
    assert classifier.calls == []


async def test_gateway_classifier_batches_and_rejects_partial_or_unknown_output() -> None:
    gateway = RecordingGateway(["hr", "not-a-candidate"])
    classifier = GatewayTopicClassifier(gateway)  # type: ignore[arg-type]

    verdicts = await classifier.classify_many(["first", "second", "third"], ["hr", "finance", "hr"])

    assert verdicts == [None, None, None]
    assert len(gateway.calls) == 1
    capability, messages, schema_name = gateway.calls[0]
    assert capability is Capability.TOPICALIZER
    assert schema_name == "GuardrailClassification"
    rendered = str(messages)
    assert "first" in rendered and "third" in rendered
    assert rendered.count("finance") == 1 and rendered.count("hr") == 1

    exact = RecordingGateway(["hr", "finance", None])
    assert await GatewayTopicClassifier(exact).classify_many(  # type: ignore[arg-type]
        ["first", "second", "third"], ["finance", "hr"]
    ) == ["hr", "finance", None]
