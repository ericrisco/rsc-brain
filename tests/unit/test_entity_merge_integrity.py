"""AUDIT-012 canonical choice is semantic and deterministic, never UUID-order alone."""

from __future__ import annotations

from typer.testing import CliRunner

from rsc_brain.cli.main import app
from rsc_brain.knowledge.entity_merge import choose_canonical
from rsc_brain.stores.relational.entity_store import EntityRow


def _entity(eid: str, name: str, *, aliases: tuple[str, ...] = ()) -> EntityRow:
    return EntityRow(
        id=eid,
        name=name,
        normalized_name=name.casefold(),
        type="condition",
        aliases=aliases,
    )


def test_canonical_rank_prefers_richer_record_over_lower_uuid_and_input_order() -> None:
    low_uuid = _entity("00000000-0000-0000-0000-000000000001", "MI")
    rich = _entity(
        "ffffffff-ffff-ffff-ffff-ffffffffffff",
        "myocardial infarction",
        aliases=("MI", "heart attack"),
    )

    assert choose_canonical((low_uuid, rich)).id == rich.id
    assert choose_canonical((rich, low_uuid)).id == rich.id


def test_merge_reversal_is_exposed_by_the_entities_cli() -> None:
    result = CliRunner().invoke(app, ["entities", "merges", "--help"])
    assert result.exit_code == 0
    assert "reverse" in result.stdout
