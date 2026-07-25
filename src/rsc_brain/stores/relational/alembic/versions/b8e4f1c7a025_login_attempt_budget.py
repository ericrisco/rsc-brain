"""shared login attempt budget (AUDIT-038 / R09)

Login verified argon2id on every attempt with no budget, so brute force was bounded only by our own
CPU cost — which also makes the same request stream a cheap denial of service. A counter in one
process would not fix it either: the deployment runs several API replicas behind one proxy, and a
per-process limit is divided by however many replicas the attacker's requests land on.

So the budget lives in Postgres, which every replica already shares, keyed by the two dimensions the
spec names: the source network and the normalized account. One row per (key, window) with an atomic
upsert-and-return, so concurrent replicas increment the same counter instead of racing separate ones.

Revision ID: b8e4f1c7a025
Revises: f7d3b1e8c204
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b8e4f1c7a025"
down_revision: str | None = "f7d3b1e8c204"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "login_attempt_window",
        sa.Column(
            "id",
            sa.Uuid(),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
            primary_key=True,
        ),
        # "network:<ip>" or "account:<normalized email>" — one table, both dimensions, so a single
        # atomic statement can charge either budget.
        sa.Column("budget_key", sa.Text(), nullable=False),
        sa.Column("window_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.UniqueConstraint("budget_key", "window_start", name="uq_login_attempt_window_key_start"),
    )
    op.create_index(
        "ix_login_attempt_window_window_start", "login_attempt_window", ["window_start"]
    )


def downgrade() -> None:
    op.drop_index("ix_login_attempt_window_window_start", table_name="login_attempt_window")
    op.drop_table("login_attempt_window")
