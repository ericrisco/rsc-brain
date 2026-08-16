"""AUDIT-084: enabling the reranker through the documented path had no effect.

Found by my own measurement's control line, not by reasoning. The G4 re-measurement set
`RSC_BRAIN_RERANKER__ENABLED=true` in `deploy/.env`, rebuilt, and printed what the container actually
saw:

    reranker.enabled = False
    ruta             = bge-reranker-v2-m3

`--env-file` makes a variable available for **interpolation in the compose file**; a container only
receives what the compose file explicitly declares. The topology declares the reranker's three route
variables — provider, model, api_base — and **not** the one switch that decides whether any of it
runs. So an operator who reads `docs/reference/configuration.md`, sets `reranker.enabled` the way
every other key is set, and restarts, gets nothing, silently.

The irony is the finding: the shipped topology carries the configuration for a route nothing called
(AUDIT-077) and omits the flag that would make it called.

Same family as AUDIT-059 (only the embedder layer was declared, so twenty entries had to be
hand-authored) and AUDIT-060 (the secrets bootstrap never wrote `PUBLIC_ORIGIN`): a key an operator
can set that never arrives.

Had the measurement not printed the effective value, this run would have recorded "the reranker does
not improve G4" — a conclusion about a component that never executed.
"""

from __future__ import annotations

from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[2]
COMPOSE = REPO / "deploy" / "docker-compose.prod.yml"


def _shared_environment() -> dict[str, object]:
    """The anchor block every service inherits."""
    loaded = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))
    for key, value in loaded.items():
        if key.startswith("x-") and isinstance(value, dict) and "RSC_BRAIN_DATABASE__DSN" in value:
            return value
    raise AssertionError("no shared environment block found in the production topology")


def test_the_reranker_switch_reaches_the_container() -> None:
    """The route without the switch configures something that never runs."""
    environment = _shared_environment()
    assert "RSC_BRAIN_RERANKER__ENABLED" in environment, (
        "the topology passes the reranker's route but not the flag that enables it, so setting it "
        "in .env silently does nothing"
    )


def test_it_stays_off_unless_the_operator_turns_it_on() -> None:
    """FR-3.6 is opt-in. Passing the variable must not change the default."""
    value = str(_shared_environment()["RSC_BRAIN_RERANKER__ENABLED"])
    assert ":-false}" in value.lower(), (
        f"the default is not false: {value!r} — an opt-in capability must stay off"
    )


def test_the_route_and_the_switch_travel_together() -> None:
    """Either both are configurable in a topology or neither is; shipping one without the other is
    what produced a container configured for a capability it could never use."""
    environment = _shared_environment()
    route = [k for k in environment if k.startswith("RSC_BRAIN_CAPABILITIES__RERANKER__")]
    assert route, "the reranker route vanished from the topology"
    assert "RSC_BRAIN_RERANKER__ENABLED" in environment, (
        f"the topology declares {len(route)} route variables and no switch"
    )


def test_the_helm_chart_carries_the_same_switch() -> None:
    """The chart and compose must not diverge on whether a capability can be turned on — the
    compose/Helm parity the repository already enforces for the rest."""
    values = yaml.safe_load(
        (REPO / "deploy" / "helm" / "rsc-brain" / "values.yaml").read_text(encoding="utf-8")
    )
    reranker = values.get("reranker")
    assert isinstance(reranker, dict) and "enabled" in reranker, (
        "the chart exposes the reranker's route but no way to enable it"
    )
    assert reranker["enabled"] is False, "an opt-in capability must ship off"
