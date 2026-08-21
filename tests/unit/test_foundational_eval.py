"""AUDIT-009: repeatable live measurement without self-certifying semantic review."""

from __future__ import annotations

import json
import re
from types import SimpleNamespace
from typing import Any

import pytest
from evals.foundational_eval import _gateway_from_args, _parser, run_foundational_eval
from evals.validate import REPO, validate_live_evidence
from pydantic import ValidationError

from rsc_brain.config.models import CapabilitiesConfig, CapabilityConfig
from rsc_brain.gateway.model_gateway import ModelGateway


def _response(payload: dict[str, Any] | str) -> SimpleNamespace:
    content = payload if isinstance(payload, str) else json.dumps(payload)
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])


def _gateway(*, discard_text: str | None = None) -> ModelGateway:
    async def completion(**kwargs: Any) -> SimpleNamespace:
        schema = kwargs["response_format"].__name__
        conversation = "\n".join(str(item.get("content", "")) for item in kwargs["messages"])
        if discard_text and discard_text in conversation and schema.endswith("Extraction"):
            return _response("invalid json")
        if schema == "EntityExtraction":
            return _response(
                {"entities": [{"name": conversation, "type": "document", "aliases": []}]}
            )
        if schema == "RelationExtraction":
            return _response({"relations": []})
        if schema == "ClaimExtraction":
            return _response({"claims": []})
        if schema == "TopicAssignment":
            tag_by_marker = {
                "software company founded": "general",
                "deployment pipeline": "engineering",
                "arquitectura de Acme": "engineering",
                "factura F-2024-118": "sales",
                "Bandas salariales": "payroll",
                "política de vacaciones": "general",
                "advises on digital": "corp",
                "standard contracts": "legal",
                "Penalty:": "legal",
                "Datos de personal": "personnel",
            }
            tags = [tag for marker, tag in tag_by_marker.items() if marker in conversation]
            return _response({"tags": tags})
        raise AssertionError(f"unexpected schema {schema}")

    cap = CapabilityConfig(provider="test", model="foundational")
    capabilities = CapabilitiesConfig(
        extractor=cap,
        judge=cap,
        topicalizer=cap,
        embedder=cap,
        reranker=cap,
    )
    return ModelGateway(capabilities, completion_fn=completion)


@pytest.mark.asyncio
async def test_runner_records_exact_outcomes_but_leaves_review_pending() -> None:
    evidence = await run_foundational_eval(
        gateway=_gateway(),
        provider="test",
        model="foundational",
        model_digest="1" * 64,
    )

    assert evidence.sample_size == 10
    assert evidence.extraction_attempts == 9
    assert evidence.extraction_discards == 0
    assert evidence.discard_rate == 0.0
    assert evidence.quality_cases_passed == 10
    assert len(evidence.results) == 10
    assert evidence.semantic_review == "assisted"
    assert evidence.semantic_reviewed is False
    assert validate_live_evidence(evidence, repo=REPO) == [
        "live evidence has not received a declared semantic review"
    ]


@pytest.mark.asyncio
async def test_one_discard_in_nine_fails_the_strict_below_ten_percent_gate() -> None:
    evidence = await run_foundational_eval(
        gateway=_gateway(discard_text="software company founded"),
        provider="test",
        model="foundational",
        model_digest="1" * 64,
    )

    assert evidence.extraction_discards == 1
    assert evidence.discard_rate == pytest.approx(1 / 9)
    assert any(result.discarded for result in evidence.results)
    assert "live extraction discard_rate must be below 10%" in validate_live_evidence(evidence)


@pytest.mark.asyncio
async def test_table_case_uses_the_production_deterministic_path_not_llm_extraction() -> None:
    evidence = await run_foundational_eval(
        gateway=_gateway(discard_text="Tier | Response"),
        provider="test",
        model="foundational",
        model_digest="1" * 64,
    )

    result = next(
        item for item in evidence.results if item.case_id == "quality-globex-sla-table-en"
    )
    assert result.extraction_attempted is False
    assert result.discarded is False
    assert result.missing_graph_terms == ()


def test_local_endpoint_needs_an_explicit_egress_grant() -> None:
    """AUDIT-005 denies a plain-HTTP loopback endpoint; the eval must ask, not assume.

    The documented command points at `http://localhost:11434`. Without the grant this run has to
    refuse rather than reach out, and with it the gateway must actually build — otherwise the
    instruction in `evals/README.md` teaches a command that cannot work (AUDIT-111).
    """
    argv = [
        "--model",
        "gemma4:12b",
        "--model-digest",
        "4eb23ef187e2c5462566d6a1d3bbbc2f1346d0b4327cbb66d58fffbcc9b2b05c",
        "--api-base",
        "http://localhost:11434",
    ]
    parser = _parser()

    with pytest.raises(ValidationError, match="allow_http"):
        _gateway_from_args(parser.parse_args(argv))

    granted = _gateway_from_args(
        parser.parse_args([*argv, "--allow-http", "--allow-private-network"])
    )

    assert granted is not None


def test_no_in_code_route_omits_the_egress_grant() -> None:
    """Every `CapabilityConfig` built in code must state its egress posture (AUDIT-111).

    Routes that come from a configuration file carry their grants in the file. A route constructed
    in code carries whatever the author remembered, and the default is deny — so an omission is not
    a security hole, it is a tool that cannot start. Both are worth failing here rather than in
    somebody's terminal an hour before they need the eval.
    """
    roots = (REPO / "src", REPO / "evals")
    offenders: list[str] = []
    for root in roots:
        for path in root.rglob("*.py"):
            source = path.read_text(encoding="utf-8")
            for match in re.finditer(r"CapabilityConfig\(", source):
                # The class definition itself is not a construction.
                if source[: match.start()].rstrip().endswith("class"):
                    continue
                call = source[match.start() : match.start() + 800]
                if "egress=" not in call.split(")")[0] + ")":
                    offenders.append(
                        f"{path.relative_to(REPO)}:{source[: match.start()].count(chr(10)) + 1}"
                    )
    assert not offenders, (
        "these in-code model routes do not state an egress posture, so they inherit deny and "
        f"cannot start: {offenders}"
    )
