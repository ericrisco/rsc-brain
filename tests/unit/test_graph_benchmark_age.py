"""The AGE benchmark adapter confines files and reports actual graph counts."""

from __future__ import annotations

from typing import cast

import pytest
from evals.graph_benchmark_age import AgeCsvBenchmarkLoader
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker


@pytest.mark.parametrize("server_root", ["benchmark", "/benchmark/../private", "/"])
def test_age_loader_refuses_unconfined_server_roots(server_root: str) -> None:
    sessions = cast(async_sessionmaker[AsyncSession], object())

    with pytest.raises(ValueError, match="confined absolute"):
        AgeCsvBenchmarkLoader(sessions, server_csv_root=server_root)


def test_age_loader_exposes_the_frozen_graph_store() -> None:
    sessions = cast(async_sessionmaker[AsyncSession], object())

    loader = AgeCsvBenchmarkLoader(sessions, server_csv_root="/benchmark")

    assert loader.graph_store.__class__.__name__ == "AgeGraphStore"
