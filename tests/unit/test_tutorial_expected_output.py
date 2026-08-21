"""The tutorial quotes exact output, so the tutorial can go stale (AUDIT-115).

`docs/tutorials/getting-started.md` prints what `brain verify` answers, including the schema
revision. Every migration moves that revision, and nothing noticed: the published tutorial promised
`f3c8e2a91d47` while the product had moved six migrations past it, so an operator following it
step by step would conclude their install was wrong.

A tutorial that quotes output is a contract with the product. These checks make it one.
"""

from __future__ import annotations

import re
from pathlib import Path

from rsc_brain import __version__
from rsc_brain.identity_release import UNKNOWN_SUFFIX
from rsc_brain.stores.relational.migrations import alembic_config

REPO = Path(__file__).resolve().parents[2]
TUTORIAL = REPO / "docs" / "tutorials" / "getting-started.md"


def _head_revision() -> str:
    from alembic.script import ScriptDirectory

    heads = ScriptDirectory.from_config(alembic_config()).get_heads()
    assert len(heads) == 1, f"expected a single migration head, found {heads}"
    return heads[0]


def test_the_tutorial_quotes_the_current_schema_head() -> None:
    quoted = set(
        re.findall(r"schema at head \(([0-9a-f]+)\)", TUTORIAL.read_text(encoding="utf-8"))
    )

    assert quoted == {_head_revision()}, (
        "the tutorial promises a schema revision the product no longer reports, so an operator "
        f"following it would think their install is broken: quoted {quoted}, head {_head_revision()}"
    )


def test_the_tutorial_quotes_the_identity_a_source_checkout_reports() -> None:
    """A source checkout is unstamped, so it reports `+unknown` — the tutorial must not promise the
    bare version, which is what a *published* build reports."""
    text = TUTORIAL.read_text(encoding="utf-8")
    expected = f"{__version__}{UNKNOWN_SUFFIX}"

    assert expected in text, f"the tutorial does not quote {expected!r}, which is what it prints"
    assert not re.search(rf"^{re.escape(__version__)}$", text, re.MULTILINE), (
        "the tutorial quotes the bare version as `brain --version` output; only a published, "
        "stamped build reports that, and a reader following the tutorial has neither"
    )
