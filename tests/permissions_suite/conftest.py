"""Fixtures for the permissions suite.

pytest only auto-discovers fixtures from conftest files on the collected test's own path, and the
real-container harness lives in the sibling `tests/integration/` package. Re-export it here so the
authorization matrix can be proven against real Postgres+AGE instead of a second, divergent
harness — one harness, one definition of "the product".
"""

from __future__ import annotations

from tests.integration.conftest import Harness, build_harness, unique_slug

__all__ = ["Harness", "build_harness", "unique_slug"]
