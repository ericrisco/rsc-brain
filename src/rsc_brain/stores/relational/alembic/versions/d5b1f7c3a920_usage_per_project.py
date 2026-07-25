"""project-bound model usage accounting (AUDIT-021 / R12)

``token_usage`` counted per (capability, day) for the whole instance, so every project's attempts
landed in one counter: each tenant read the pooled total as if it were its own, and one project's
traffic exhausted another's daily budget. The counter becomes per (project, capability, day).

Pre-existing rows cannot be attributed to a project after the fact, and guessing would be worse
than admitting it: they keep ``project_id NULL``, which excludes them from every project's report
(each report filters on its own project) while leaving them in the operator's runtime total. No row
is reassigned, silently or otherwise (plan §7: never silently reassign ownership).

Revision ID: d5b1f7c3a920
Revises: a7c3e1f9d248
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d5b1f7c3a920"
down_revision: str | None = "a7c3e1f9d248"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "token_usage",
        sa.Column(
            "project_id",
            sa.Uuid(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=True,
        ),
    )
    # The old identity (capability, day) is what pooled the tenants; the new one owns the counter.
    op.drop_constraint("uq_token_usage_capability_day", "token_usage", type_="unique")
    # NULLS NOT DISTINCT keeps the counter identity intact for unattributed rows: without it two
    # unattributed attempts insert two rows, the upsert never matches, and the counter under-reports.
    op.execute(
        "ALTER TABLE token_usage ADD CONSTRAINT uq_token_usage_project_id_capability_day "
        "UNIQUE NULLS NOT DISTINCT (project_id, capability, day)"
    )
    op.create_index("ix_token_usage_project_id_day", "token_usage", ["project_id", "day"])


def downgrade() -> None:
    # Reversing loses attribution, so it collapses to one row per (capability, day) again: sum the
    # per-project counters instead of failing on the duplicate the old constraint would find.
    op.drop_index("ix_token_usage_project_id_day", table_name="token_usage")
    op.drop_constraint(
        "uq_token_usage_project_id_capability_day", "token_usage", type_="unique"
    )
    op.execute(
        """
        WITH pooled AS (
            SELECT capability, day, sum(tokens) AS tokens, sum(calls) AS calls,
                   min(id::text)::uuid AS keep
            FROM token_usage GROUP BY capability, day
        )
        UPDATE token_usage u
           SET tokens = p.tokens, calls = p.calls
          FROM pooled p
         WHERE u.id = p.keep
        """
    )
    op.execute(
        """
        DELETE FROM token_usage u
         WHERE u.id NOT IN (
            SELECT min(id::text)::uuid FROM token_usage GROUP BY capability, day
         )
        """
    )
    op.drop_column("token_usage", "project_id")
    op.create_unique_constraint(
        "uq_token_usage_capability_day", "token_usage", ["capability", "day"]
    )
