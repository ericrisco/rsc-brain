"""AUDIT-092: the restore runbook could not be executed as written on a fresh target.

Run verbatim against a real inactive Compose target, its second command failed:

    docker compose ... run --rm --no-deps api mkdir -p /var/lib/rsc-brain/data/operator-restores
    mkdir: cannot create directory '/var/lib/rsc-brain/data/operator-restores': Permission denied

The image runs as UID 10001; a newly created Docker volume belongs to root. Every command in the
recipe runs inside that image, so the failure cascades: the copy has no destination, `brain restore`
finds no manifest, and `brain verify` reports a schema that was never migrated.

`deploy/README.md` documents this ownership task for **installation**, in its own section, with the
exact command. The restore page said only "a new, empty, writable data directory or PVC" — writable
by whom was the whole question, and a new volume is precisely the state that is not.

Nothing was wrong with the machinery. Adding the one missing `chown` and re-running the recipe
unchanged produced:

    brain restore: restored ... (10 stored documents) and verified.
    brain verify:  {"status": "ok", ... "schema at head (f3c8e2a91d47)"}
    ORIGEN      10 docs / 802 chunks / 2 proyectos / 5 topics / 2 usuarios
    RESTAURADO  10 docs / 802 chunks / 2 proyectos / 5 topics / 2 usuarios

`brain restore` itself behaved exactly as it should throughout — it refused an unverifiable snapshot,
said why, and changed nothing. The defect was only ever in the page an operator follows during a
disaster, which is the worst moment to discover that step two does not run.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
RUNBOOK = REPO / "docs" / "how-to" / "backup-and-restore.md"
DEPLOY = REPO / "deploy" / "README.md"


def _restore_half() -> str:
    """Everything from the restore-target preparation onward.

    The backup half of the page legitimately says nothing about ownership: it runs against a volume
    the install already provisioned. Only the restore half creates a fresh target.
    """
    text = RUNBOOK.read_text(encoding="utf-8")
    start = text.index("## Prepare an inactive restore target")
    return text[start:]


def test_the_restore_runbook_names_the_ownership_step() -> None:
    """An operator restoring under pressure must not have to infer it from the install guide."""
    half = _restore_half()
    assert "10001" in half, (
        "the restore runbook never names the runtime UID, so its first command fails with "
        "Permission denied on any freshly created volume"
    )
    assert "chown" in half, (
        "the restore runbook states the volume must be writable but never says how to make it so"
    )


def test_it_gives_the_command_and_not_only_the_requirement() -> None:
    """ "Writable" was already there and was not enough. The recipe is executed, not interpreted."""
    half = _restore_half()
    assert re.search(r"chown -R 10001:10001\s+/var/lib/rsc-brain/data", half), (
        "the ownership requirement is described but the runnable command is missing, which is the "
        "difference between a runbook and a note"
    )


def test_the_ownership_step_precedes_the_step_that_failed() -> None:
    """Order is the whole finding: the chown has to come before the first in-image command."""
    half = _restore_half()
    chown = half.index("chown -R 10001:10001")
    mkdir = half.index("mkdir -p /var/lib/rsc-brain/data/operator-restores")
    assert chown < mkdir, (
        "the ownership step is documented after the command it exists to make work"
    )


def test_the_install_guide_still_owns_the_canonical_instruction() -> None:
    """The restore page points at it rather than forking a second copy that can drift."""
    assert "### Provision application-volume ownership" in DEPLOY.read_text(encoding="utf-8"), (
        "the section the restore runbook links to has moved or been renamed; the cross-reference "
        "is now dead"
    )
    assert "deploy/README.md#provision-application-volume-ownership" in _restore_half(), (
        "the restore runbook no longer points at the canonical ownership instruction"
    )
