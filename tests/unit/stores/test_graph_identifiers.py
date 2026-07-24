"""Unit: graph names and labels/edge-types are validated identifiers, not interpolated data.

This is the static guard against Cypher injection: the only values placed into the SQL text
(graph name, label, edge type) must pass strict identifier validation; everything else is a
Cypher parameter.
"""

from __future__ import annotations

import uuid

import pytest

from rsc_brain.stores.age_graph_store import (
    UnsafeIdentifierError,
    graph_name,
    safe_identifier,
)


def test_graph_name_is_derived_from_the_uuid() -> None:
    pid = str(uuid.uuid4())
    assert graph_name(pid) == "p_" + uuid.UUID(pid).hex


def test_graph_name_rejects_non_uuid_input() -> None:
    with pytest.raises(ValueError):
        graph_name("'; SELECT drop_graph('x', true); --")


def test_safe_identifier_accepts_valid_labels() -> None:
    assert safe_identifier("Entity") == "Entity"
    assert safe_identifier("KNOWS_ABOUT") == "KNOWS_ABOUT"


@pytest.mark.parametrize(
    "bad",
    [
        "Entity) DETACH DELETE n //",
        "has space",
        "1leading_digit",
        "dash-name",
        "$param",
        "",
    ],
)
def test_safe_identifier_rejects_injection_attempts(bad: str) -> None:
    with pytest.raises(UnsafeIdentifierError):
        safe_identifier(bad)
