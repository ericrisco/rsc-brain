"""Tenant-qualified relational references (AUDIT-039 / R17) — the relation map and its preflight.

Every tenant-owned child row must belong to the same project as its parent, and that must be the
DATABASE's guarantee: application checks are exactly what a bug, a repair script, a migration or a
future code path can bypass, and once such a row exists it is invisible to every scope check that
only looks at the row's own ``project_id``.

The relation map is derived from the mapped schema rather than hand-listed, so a relation added
later is covered without editing anything here.

:func:`cross_project_violations` is the migration preflight: it REPORTS pre-existing violations and
never repairs them. Reassigning a row's ownership is a data-loss decision about which tenant owns a
fact — an operator's call, made with the report in hand, never a migration's side effect.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.engine import Connection

from rsc_brain.stores.relational import models

PROJECT_COLUMN = "project_id"


@dataclass(frozen=True, slots=True)
class TenantRelation:
    """One child → parent reference where both sides are tenant-owned."""

    child: str
    parent: str
    column: str
    constraint: str
    ondelete: str | None

    @property
    def qualified_constraint(self) -> str:
        """Name of the project-qualified replacement constraint."""
        return f"fk_{self.child}_{PROJECT_COLUMN}_{self.column}_{self.parent}"


def tenant_relations() -> list[TenantRelation]:
    """Every tenant-owned child → parent reference in the mapped schema, deterministically ordered."""
    relations: list[TenantRelation] = []
    for table in models.Base.metadata.sorted_tables:
        if PROJECT_COLUMN not in table.c:
            continue
        for constraint in table.foreign_key_constraints:
            parent = constraint.referred_table
            if parent.name == table.name or PROJECT_COLUMN not in parent.c:
                continue
            columns = [c.name for c in constraint.columns if c.name != PROJECT_COLUMN]
            if len(columns) != 1:  # pragma: no cover - no multi-column tenant reference exists
                continue
            element = next(iter(constraint.elements))
            relations.append(
                TenantRelation(
                    child=table.name,
                    parent=parent.name,
                    column=columns[0],
                    constraint=str(constraint.name or ""),
                    ondelete=element.ondelete,
                )
            )
    return sorted(relations, key=lambda r: (r.child, r.column))


def parent_tables() -> list[str]:
    """Parent tables that need a ``(project_id, id)`` unique key to be referenced by one."""
    return sorted({relation.parent for relation in tenant_relations()})


def cross_project_violations(connection: Connection) -> dict[str, int]:
    """``{"child.column -> parent": row_count}`` for rows whose parent is in another project.

    Read-only by construction: the caller decides what to do about each one. An empty mapping is the
    precondition the qualified constraints need — and the only thing that makes adding them safe.
    """
    found: dict[str, int] = {}
    for relation in tenant_relations():
        count = connection.execute(
            # table in this module — a literal list, not input. The preflight has to name tables it was
            # written against, and a bind parameter cannot be an identifier.
            text(
                f"""
                SELECT count(*) FROM {relation.child} c
                JOIN {relation.parent} p ON p.id = c.{relation.column}
                WHERE c.{PROJECT_COLUMN} IS DISTINCT FROM p.{PROJECT_COLUMN}
                """  # noqa: S608
            )
        ).scalar()
        if count:
            found[f"{relation.child}.{relation.column} -> {relation.parent}"] = int(count)
    return found


def violation_report(violations: dict[str, int]) -> str:
    """A quarantine report an operator can act on, listing each relation and its row count."""
    lines = [f"  {relation}: {count} row(s)" for relation, count in sorted(violations.items())]
    return (
        "cross-project references exist and must be resolved by an operator before the "
        "project-qualified constraints can be added (no row is reassigned automatically):\n"
        + "\n".join(lines)
    )
