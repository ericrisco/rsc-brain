"""AUDIT-107: correction rows carry an unambiguous, typed validity snapshot."""

from __future__ import annotations

from sqlalchemy import DateTime, Text, Uuid

from rsc_brain.stores.relational import models


def test_correction_maps_the_durable_validity_restore_contract() -> None:
    columns = models.Correction.__table__.c

    assert isinstance(columns.target_valid_from_before.type, DateTime)
    assert columns.target_valid_from_before.type.timezone is True
    assert isinstance(columns.target_valid_to_before.type, DateTime)
    assert columns.target_valid_to_before.type.timezone is True
    assert isinstance(columns.validity_snapshot_captured_at.type, DateTime)
    assert columns.validity_snapshot_captured_at.type.timezone is True
    assert isinstance(columns.lifecycle_error.type, Text)
    assert isinstance(columns.reverted_by.type, Uuid)


def test_snapshot_marker_distinguishes_open_interval_from_missing_snapshot() -> None:
    correction = models.Correction(
        target_valid_from_before=None,
        target_valid_to_before=None,
        validity_snapshot_captured_at=None,
    )

    assert correction.target_valid_from_before is None
    assert correction.target_valid_to_before is None
    assert correction.validity_snapshot_captured_at is None
