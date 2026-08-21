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
    assert doc["type"] == "Skill"
    assert doc["okf_version"] == OKF_VERSION and doc["kind"] == OKF_KIND
    assert doc["title"] == "Reset a user password"  # OKF-native, unprefixed
    # Product fields are namespaced; okf_version/kind remain only as a legacy envelope.
    for key in doc:
        assert key in {
            "type",
            "okf_version",
            "kind",
            "title",
            "description",
            "tags",
        } or key.startswith("rsc_brain_")
    validate_okf(doc)  # a serialized skill validates against the OKF v0.1 structural contract


def test_round_trip_is_lossless() -> None:
    body = "## Steps\n\n1. Verify identity\n2. Issue a reset link\n"
    text = serialize_skill(_FM, body)
    parsed_fm, parsed_body = parse_skill(text)
    assert parsed_fm == _FM
    assert parsed_body == body


def test_producer_extensions_are_accepted_and_round_trip_losslessly() -> None:
    doc = _FM.to_okf()
    extension = {
        "producer": "another-agent",
        "signals": [True, 3, None, {"recorded_at": "2026-08-21T06:30:00Z"}],
    }
    doc["acme_extension"] = extension
    validate_okf(doc)

    text = "---\n" + __import__("yaml").safe_dump(doc, sort_keys=True) + "---\nbody"
    parsed, body = parse_skill(text)
    assert parsed.extensions == {"acme_extension": extension}
    assert parse_skill(serialize_skill(parsed, body))[0].extensions == {"acme_extension": extension}


def test_local_envelope_is_not_a_normative_requirement() -> None:
    text = """---
type: Skill
title: Portable
rsc_brain_slug: portable
foreign_flag: true
foreign_timestamp: 2026-08-21T06:30:00Z
---
body
"""
    parsed, _ = parse_skill(text)
    assert parsed.slug == "portable"
    assert parsed.extensions == {
        "foreign_flag": True,
        "foreign_timestamp": "2026-08-21T06:30:00Z",
    }


def test_absent_native_optional_fields_are_not_serialized_as_null() -> None:
    doc = SkillFrontmatter(slug="minimal", title="Minimal").to_okf()
    assert "description" not in doc


def test_non_json_extension_values_are_rejected_precisely() -> None:
    text = """---
type: Skill
title: Invalid extension
rsc_brain_slug: invalid-extension
producer_score: .nan
---
body
"""
    with pytest.raises(SkillFrontmatterError, match=r"frontmatter\.producer_score"):
        parse_skill(text)


def test_wrong_envelope_is_rejected() -> None:
    with pytest.raises(SkillFrontmatterError, match="type must be a non-empty string"):
        validate_okf({"okf_version": "0.1", "kind": "skill", "title": "x"})
    with pytest.raises(SkillFrontmatterError, match="type must be a non-empty string"):
        validate_okf({"type": "   ", "title": "x"})
    with pytest.raises(SkillFrontmatterError):
        parse_skill("no frontmatter here")
