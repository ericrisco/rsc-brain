"""Topicalizer (FR-1.7): admin rules win over the LLM; output constrained to the taxonomy."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest

from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.ingest.topicalizer import Topicalizer
from rsc_brain.ingest.types import TopicRule

TAXONOMY = ["general", "engineering", "hr"]


async def test_admin_rule_wins_and_model_is_not_consulted(
    gateway_factory: Callable[..., ModelGateway],
) -> None:
    async def _must_not_be_called(**_: Any) -> Any:
        raise AssertionError("LLM must not be called when a rule matches")

    gateway = gateway_factory(completion=_must_not_be_called)
    topicalizer = Topicalizer(gateway)
    rules = [TopicRule(pattern=r"payroll|n[oó]mina", tag="hr")]
    tags = await topicalizer.tag(
        "Monthly payroll figures", taxonomy=TAXONOMY, rules=rules, default_tag="general"
    )
    assert tags == ("hr",)


async def test_model_tags_are_filtered_to_the_taxonomy(
    gateway_factory: Callable[..., ModelGateway],
    make_completion: Callable[..., Any],
) -> None:
    completion = make_completion(tags=["engineering", "not_a_real_tag"])
    gateway = gateway_factory(completion=completion)
    tags = await Topicalizer(gateway).tag(
        "CI pipeline details", taxonomy=TAXONOMY, rules=[], default_tag="general"
    )
    assert tags == ("engineering",)


async def test_falls_back_to_default_when_model_returns_nothing(
    gateway_factory: Callable[..., ModelGateway],
    make_completion: Callable[..., Any],
) -> None:
    gateway = gateway_factory(completion=make_completion(tags=[]))
    tags = await Topicalizer(gateway).tag(
        "ambiguous text", taxonomy=TAXONOMY, rules=[], default_tag="general"
    )
    assert tags == ("general",)


async def test_falls_back_to_default_when_gateway_fails(
    gateway_factory: Callable[..., ModelGateway],
) -> None:
    async def _boom(**_: Any) -> Any:
        raise RuntimeError("provider down")

    gateway = gateway_factory(completion=_boom)
    tags = await Topicalizer(gateway).tag(
        "text", taxonomy=TAXONOMY, rules=[], default_tag="general"
    )
    assert tags == ("general",)


@pytest.mark.parametrize("pattern", [r"nómina", r"NÓMINA"])
async def test_rule_matching_is_case_insensitive(
    gateway_factory: Callable[..., ModelGateway], pattern: str
) -> None:
    async def _unused(**_: Any) -> Any:  # pragma: no cover - not reached
        raise AssertionError

    gateway = gateway_factory(completion=_unused)
    tags = await Topicalizer(gateway).tag(
        "Datos de Nómina de dirección",
        taxonomy=TAXONOMY,
        rules=[TopicRule(pattern=pattern, tag="hr")],
        default_tag="general",
    )
    assert tags == ("hr",)
