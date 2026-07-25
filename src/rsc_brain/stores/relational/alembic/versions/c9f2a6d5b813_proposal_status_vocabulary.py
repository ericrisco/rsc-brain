"""One vocabulary for merge-proposal status, enforced by the database (AUDIT-019 / R25).

Three sets of words for the same lifecycle had grown: the producer wrote ``needs_review`` and confirmed
to ``applied``, the review queue selected ``pending``, and the console resolver confirmed to
``confirmed``. The consequence was not cosmetic — a queued proposal was invisible in the console and
unresolvable from it, because the query asked for a status nothing writes.

Shared constants fix today's drift; a CHECK constraint fixes tomorrow's. Existing rows written by
earlier versions are mapped first (``pending`` → ``needs_review``, ``confirmed`` → ``applied``), so an
install that already has proposals keeps them, in the canonical spelling.

Revision ID: c9f2a6d5b813
Revises: b8e4f1c7a025
"""

from __future__ import annotations

from alembic import op

revision = "c9f2a6d5b813"
down_revision = "b8e4f1c7a025"
branch_labels = None
depends_on = None

CONSTRAINT = "ck_entity_merge_proposals_status"
# Frozen literals: a migration must keep meaning the same thing after the application's constants move
# on, so it does not import them (the same discipline as the tenant-reference migration).
STATES = ("needs_review", "applied", "auto_applied", "rejected")
LEGACY = (("pending", "needs_review"), ("confirmed", "applied"))


def upgrade() -> None:
    for old, new in LEGACY:
        op.execute(
            f"UPDATE entity_merge_proposals SET status = '{new}' WHERE status = '{old}'"  # noqa: S608
        )
    allowed = ", ".join(f"'{state}'" for state in STATES)
    op.create_check_constraint(CONSTRAINT, "entity_merge_proposals", f"status IN ({allowed})")


def downgrade() -> None:
    # The constraint goes; the rows keep the canonical spelling, because rewriting them back to
    # `pending`/`confirmed` would hand a downgraded install the exact bug this migration removed.
    op.drop_constraint(CONSTRAINT, "entity_merge_proposals", type_="check")
