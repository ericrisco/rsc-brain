"""ingest runs (stage checkpoints) and the procrastinate job queue schema

Revision ID: 2c9e1a7b4d83
Revises: 1f461b206f32
Create Date: 2026-07-24 05:55:00.000000

SPEC-05. Adds ``ingest_runs`` (per-document run with per-stage checkpoints, FR-1.10) and applies
procrastinate's own schema from its packaged DDL, so ``brain migrate`` fully provisions the queue
(no separate ``procrastinate schema`` step). procrastinate objects are excluded from Alembic
autogenerate/drift in ``env.py`` since they are not SQLAlchemy models.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "2c9e1a7b4d83"
down_revision: str | None = "1f461b206f32"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "ingest_runs",
        sa.Column(
            "id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("phase", sa.Text(), nullable=False),
        sa.Column(
            "completed_stages",
            postgresql.ARRAY(sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column("chunks_created", sa.Integer(), server_default="0", nullable=False),
        sa.Column("claims_generated", sa.Integer(), server_default="0", nullable=False),
        sa.Column("tables_converted", sa.Integer(), server_default="0", nullable=False),
        sa.Column("tables_needs_review", sa.Integer(), server_default="0", nullable=False),
        sa.Column("discarded_chunks", sa.Integer(), server_default="0", nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            name=op.f("fk_ingest_runs_project_id_projects"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_ingest_runs_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ingest_runs")),
        sa.UniqueConstraint("document_id", name=op.f("uq_ingest_runs_document_id")),
    )
    op.create_index(
        "ix_ingest_runs_project_id_id", "ingest_runs", ["project_id", "id"], unique=False
    )

    # Per-phase deltas on chunks (SPEC-05): cut_type provenance (FR-1.6) + the needs_review flag
    # for header-less tables retained but never published (FR-1.5).
    op.add_column("chunks", sa.Column("cut_type", sa.Text(), nullable=True))
    op.add_column(
        "chunks",
        sa.Column("needs_review", sa.Boolean(), server_default="false", nullable=False),
    )

    # Apply procrastinate's packaged schema (FR-1.10). Imported lazily so importing this module
    # for offline autogenerate never requires the queue driver. The schema is a multi-statement
    # script; asyncpg rejects multi-statement text, so it is split into individual statements
    # (respecting dollar-quoted function bodies) and applied one at a time.
    from procrastinate.schema import SchemaManager

    for statement in _split_sql_statements(SchemaManager.get_schema()):
        op.execute(statement)


def downgrade() -> None:
    from procrastinate.schema import SchemaManager

    # Best-effort teardown of procrastinate objects, then our table.
    for statement in _procrastinate_teardown(SchemaManager.get_schema()):
        op.execute(statement)
    op.drop_column("chunks", "needs_review")
    op.drop_column("chunks", "cut_type")
    op.drop_index("ix_ingest_runs_project_id_id", table_name="ingest_runs")
    op.drop_table("ingest_runs")


def _split_sql_statements(sql: str) -> list[str]:
    """Split a Postgres SQL script into individual statements, honoring dollar-quoted bodies
    (``$$``/``$tag$``), single-quoted strings, and ``--`` line comments — so semicolons inside
    a PL/pgSQL function body do not split the statement."""
    statements: list[str] = []
    buffer: list[str] = []
    dollar_tag: str | None = None
    in_single_quote = False
    in_line_comment = False
    index = 0
    length = len(sql)
    while index < length:
        char = sql[index]
        if in_line_comment:
            buffer.append(char)
            if char == "\n":
                in_line_comment = False
            index += 1
            continue
        if dollar_tag is not None:
            if sql.startswith(dollar_tag, index):
                buffer.append(dollar_tag)
                index += len(dollar_tag)
                dollar_tag = None
                continue
            buffer.append(char)
            index += 1
            continue
        if in_single_quote:
            buffer.append(char)
            if char == "'":
                in_single_quote = False
            index += 1
            continue
        if sql.startswith("--", index):
            buffer.append("--")
            in_line_comment = True
            index += 2
            continue
        if char == "'":
            in_single_quote = True
            buffer.append(char)
            index += 1
            continue
        if char == "$":
            match = re.match(r"\$[A-Za-z0-9_]*\$", sql[index:])
            if match is not None:
                dollar_tag = match.group(0)
                buffer.append(dollar_tag)
                index += len(dollar_tag)
                continue
        if char == ";":
            statement = "".join(buffer).strip()
            if _has_executable_sql(statement):
                statements.append(statement)
            buffer = []
            index += 1
            continue
        buffer.append(char)
        index += 1
    tail = "".join(buffer).strip()
    if _has_executable_sql(tail):
        statements.append(tail)
    return statements


def _has_executable_sql(statement: str) -> bool:
    """True if ``statement`` has any content beyond ``--`` comments/whitespace (asyncpg rejects
    an empty query)."""
    for line in statement.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("--"):
            return True
    return False


def _procrastinate_teardown(schema_sql: str) -> list[str]:
    """Derive DROP statements for every table/type the procrastinate schema creates."""
    tables: list[str] = []
    types: list[str] = []
    for line in schema_sql.splitlines():
        stripped = line.strip()
        upper = stripped.upper()
        if upper.startswith("CREATE TABLE"):
            tables.append(stripped.split()[2].rstrip("("))
        elif upper.startswith("CREATE TYPE"):
            types.append(stripped.split()[2])
    drops = [f"DROP TABLE IF EXISTS {name} CASCADE" for name in tables]
    drops += [f"DROP TYPE IF EXISTS {name} CASCADE" for name in types]
    return drops
