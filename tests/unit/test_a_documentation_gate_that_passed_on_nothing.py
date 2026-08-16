"""AUDIT-086: the documentation coverage gate passed precisely when its collector broke.

Found by a dependency bump, which is the only reason it was ever visible.

`check_reference_contract` proves every public interface has a lookup token in its reference page,
by subtracting the documented tokens from an inventory the collector builds. The subtraction is
the whole gate:

    missing = set(inventory) - set(documented)

An **empty inventory** subtracts to the empty set. So a collector that returns nothing reports
"nothing undocumented" — the rule goes green having checked no interface at all. The gate is
loudest when it works and silent when it is broken, which is backwards.

That is not hypothetical. `collect_cli` walked the command tree with
`isinstance(command, click.Group)`. Typer 0.27 vendors its own click, so the root became a
`typer._click.core.Command` and the isinstance quietly turned false. The walk stopped at the root,
`collect_cli` returned `set()`, and every one of `brain`'s commands left the inventory at once. The
product does not import click anywhere — nothing about the CLI changed. Had `test_documentation`
not asserted that a known command is *present* in the inventory, `uv run python scripts/check_docs.py`
would have reported a clean documentation contract over zero commands.

Same family as AUDIT-082 (a G3 gate that passed on an empty stratum) and the run's recurring shape:
a signal that proves less than it appears. The defence is the same — make the check fail when the
population it measures disappears.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from scripts import check_docs

REPO = Path(__file__).resolve().parents[2]


def test_the_cli_inventory_survives_typers_vendored_click() -> None:
    """The regression itself: the walk must not depend on which click class typer wraps."""
    inventory = check_docs.collect_cli(REPO)
    assert inventory, "the CLI inventory is empty — the command-tree walk found nothing"
    assert "brain init" in inventory, "a top-level command is missing from the inventory"
    assert "brain topics grant" in inventory, "the walk did not descend into subcommands"


@pytest.mark.parametrize(
    ("collector", "rule"),
    [
        ("collect_cli", "cli-coverage"),
        ("collect_mcp", "mcp-coverage"),
        ("collect_config", "config-coverage"),
        ("collect_openapi", "openapi-coverage"),
    ],
)
def test_an_empty_inventory_fails_the_gate(
    monkeypatch: pytest.MonkeyPatch, collector: str, rule: str
) -> None:
    """A collector that returns nothing must be reported, not rewarded with a pass."""
    monkeypatch.setattr(check_docs, collector, lambda _repository: set())
    findings = check_docs.check_reference_contract(REPO)
    offending = [f for f in findings if f.rule == rule]
    assert offending, (
        f"{collector} returned an empty inventory and {rule} still passed — the gate reports "
        "'fully documented' exactly when it has checked nothing"
    )
    assert "empty inventory" in offending[0].message


def test_the_gate_is_clean_when_every_collector_works() -> None:
    """The counterweight: the guard must not fire on the real repository.

    Without this, 'always emit a finding' would satisfy the test above and break the build.
    """
    findings = check_docs.check_reference_contract(REPO)
    empties = [f for f in findings if "empty inventory" in f.message]
    assert not empties, f"a collector is broken on the real repository: {empties}"
