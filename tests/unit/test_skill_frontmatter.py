"""Skill frontmatter: OKF compatibility + lossless round-trip (SPEC-20, FR-7.4)."""

from __future__ import annotations

import pytest

from rsc_brain.skills.frontmatter import (
    OKF_KIND,
    OKF_VERSION,
    SkillFrontmatter,
    SkillFrontmatterError,
    parse_skill,
    serialize_skill,
    validate_okf,
)

_FM = SkillFrontmatter(
    slug="reset-password",
    title="Reset a user password",
    description="How we reset passwords here",
    when_to_use="A user is locked out",
    when_not="The account is disabled",
    tags=["hr", "it"],
    owner="alice",
    depends_on=["11111111-1111-1111-1111-111111111111"],
    state="active",
    version=2,
)


def test_okf_envelope_and_namespacing() -> None:
    doc = _FM.to_okf()
    assert doc["okf_version"] == OKF_VERSION and doc["kind"] == OKF_KIND
    assert doc["title"] == "Reset a user password"  # OKF-native, unprefixed
    # Every non-native field is under the rsc_brain_ namespace (FR-7.4).
    for key in doc:
        assert key in {"okf_version", "kind", "title", "description"} or key.startswith(
            "rsc_brain_"
        )
    validate_okf(doc)  # a serialized skill validates against the OKF v0.1 structural contract


def test_round_trip_is_lossless() -> None:
    body = "## Steps\n\n1. Verify identity\n2. Issue a reset link\n"
    text = serialize_skill(_FM, body)
    parsed_fm, parsed_body = parse_skill(text)
    assert parsed_fm == _FM
    assert parsed_body == body


def test_non_namespaced_field_is_rejected() -> None:
    doc = _FM.to_okf()
    doc["rogue_field"] = "x"  # not OKF-native, not namespaced
    with pytest.raises(SkillFrontmatterError):
        validate_okf(doc)


def test_wrong_envelope_is_rejected() -> None:
    with pytest.raises(SkillFrontmatterError):
        validate_okf({"okf_version": "9.9", "kind": "skill", "title": "x"})
    with pytest.raises(SkillFrontmatterError):
        parse_skill("no frontmatter here")
