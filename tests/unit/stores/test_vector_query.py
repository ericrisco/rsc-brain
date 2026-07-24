"""Unit: the vector search filter (project + tags) is embedded IN the SQL (FR-4.2)."""

from __future__ import annotations

import uuid

from sqlalchemy.dialects import postgresql

from rsc_brain.stores.pgvector_store import build_search_statement


def test_project_and_tag_filter_are_in_the_query() -> None:
    statement = build_search_statement(uuid.uuid4(), [0.0] * 1024, ["hr"], 5)
    dialect = postgresql.dialect()  # type: ignore[no-untyped-call]  # untyped in SQLAlchemy stubs
    sql = str(statement.compile(dialect=dialect))
    assert "project_id" in sql  # project filter in the query
    assert "&&" in sql  # tag-array overlap in the query
    assert "<=>" in sql  # cosine distance operator (HNSW index)
    assert "LIMIT" in sql.upper()
