"""Independent, offline OKF v0.1 compatibility evidence (AUDIT-015)."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

from rsc_brain.skills.frontmatter import (
    SkillFrontmatter,
    SkillFrontmatterError,
    parse_skill,
    serialize_skill,
)

ROOT = Path(__file__).parents[2]
REFERENCE = ROOT / "vendor" / "okf" / "v0.1"
VALIDATOR = ROOT / "scripts" / "validate_okf_v01.py"


def test_normative_copy_is_attributable_and_checksum_pinned() -> None:
    provenance = json.loads((REFERENCE / "PROVENANCE.json").read_text(encoding="utf-8"))
    assert provenance["upstream_commit"] == "d44368c15e38e7c92481c5992e4f9b5b421a801d"
    assert (
        hashlib.sha256((REFERENCE / "SPEC.md").read_bytes()).hexdigest()
        == provenance["spec_sha256"]
    )
    assert (
        hashlib.sha256((REFERENCE / "LICENSE.md").read_bytes()).hexdigest()
        == provenance["license_sha256"]
    )
    spec = (REFERENCE / "SPEC.md").read_text(encoding="utf-8")
    assert "Version 0.1 — Draft" in spec
    assert "type: <Type name>" in spec
    assert "Apache License" in (REFERENCE / "LICENSE.md").read_text(encoding="utf-8")


def test_serialized_skill_passes_independent_offline_validator(tmp_path: Path) -> None:
    skill = tmp_path / "skill.md"
    skill.write_text(
        serialize_skill(
            SkillFrontmatter(
                slug="portable",
                title="Portable",
                extensions={"other_producer": {"enabled": True}},
            ),
            "# Procedure\n",
        ),
        encoding="utf-8",
    )

    result = subprocess.run(
        [sys.executable, str(VALIDATOR), str(skill), "--reference", str(REFERENCE)],
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


def test_invalid_concept_is_rejected_by_product_and_independent_gate(tmp_path: Path) -> None:
    invalid = tmp_path / "invalid.md"
    invalid.write_text(
        "---\ntitle: Missing type\nrsc_brain_slug: missing\n---\nbody\n", encoding="utf-8"
    )

    with pytest.raises(SkillFrontmatterError, match="type must be a non-empty string"):
        parse_skill(invalid.read_text(encoding="utf-8"))

    result = subprocess.run(
        [sys.executable, str(VALIDATOR), str(invalid), "--reference", str(REFERENCE)],
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 1
    assert "type: required non-empty string" in result.stderr
