"""No mapped identifier may exceed Postgres's 63-character limit.

Postgres TRUNCATES an over-length identifier silently. The constraint still gets created, so nothing
fails at upgrade time — but its real name is no longer the one that created it, and any later
statement that names it (a rollback dropping it, an autogenerate diff comparing it) works on a name
that does not exist. Two project-qualified foreign keys hit exactly this, and only a downgrade
revealed it.
"""

from __future__ import annotations

from sqlalchemy.schema import Constraint, Index

from rsc_brain.stores.relational import models

MAX_IDENTIFIER_LENGTH = 63


def test_no_mapped_identifier_would_be_truncated() -> None:
    too_long: list[str] = []
    for table in models.Base.metadata.sorted_tables:
        objects: list[Constraint | Index] = [*table.constraints, *table.indexes]
        for obj in objects:
            name = obj.name
            if isinstance(name, str) and len(name) > MAX_IDENTIFIER_LENGTH:
                too_long.append(f"{table.name}: {name} ({len(name)} chars)")
    assert not too_long, (
        "these identifiers would be silently truncated by Postgres, so the mapped name and the "
        f"deployed name would differ — give each an explicit short name: {too_long}"
    )
