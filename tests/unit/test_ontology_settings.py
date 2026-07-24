"""Unit tests for per-project ontology settings + the relation-check policy (SPEC-24, FR-17.1/17.4)."""

from __future__ import annotations

import pytest

from rsc_brain.ontology.index import OntologyIndex
from rsc_brain.ontology.ingest import build_relation_decider
from rsc_brain.ontology.settings import OntologySettings
from tests.unit.test_ontology_index import COMPANY, FIXTURE, LEASE, PERSON  # reuse the fixture


def test_defaults_are_off_and_conservative() -> None:
    settings = OntologySettings()
    assert settings.enabled is False
    assert settings.strategy == "exact"
    assert settings.relation_check == "warn"
    assert settings.inference_depth == 1


def test_validate_from_settings_dict() -> None:
    settings = OntologySettings.model_validate(
        {"enabled": True, "strategy": "fuzzy", "threshold": 0.7, "inference_depth": 2}
    )
    assert settings.enabled is True
    assert settings.strategy == "fuzzy"
    assert settings.threshold == 0.7
    assert settings.inference_depth == 2


def test_extra_keys_ignored() -> None:
    settings = OntologySettings.model_validate({"enabled": True, "unknown_key": "x"})
    assert settings.enabled is True


def test_invalid_strategy_rejected() -> None:
    with pytest.raises(ValueError):
        OntologySettings.model_validate({"strategy": "telepathy"})


@pytest.fixture
def index() -> OntologyIndex:
    return OntologyIndex.parse(FIXTURE, "turtle")


def test_decider_warn_flags_violation(index: OntologyIndex) -> None:
    decide = build_relation_decider(index, OntologySettings(relation_check="warn"))
    assert decide("signs", "person", "lease") == "keep"
    assert decide("signs", "person", "company") == "flag"


def test_decider_drop_discards_violation(index: OntologyIndex) -> None:
    decide = build_relation_decider(index, OntologySettings(relation_check="drop"))
    assert decide("signs", "person", "company") == "drop"


def test_decider_allow_never_checks(index: OntologyIndex) -> None:
    decide = build_relation_decider(index, OntologySettings(relation_check="allow"))
    assert decide("signs", "person", "company") == "keep"


def test_decider_labels_anchor_to_iris(index: OntologyIndex) -> None:
    # "lease"/"company" anchor to LEASE/COMPANY; a valid range (Lease is-a Contract) is kept.
    assert LEASE.endswith("Lease") and COMPANY.endswith("Company") and PERSON.endswith("Person")
    decide = build_relation_decider(index, OntologySettings(relation_check="warn"))
    assert decide("signs", "person", "lease") == "keep"
