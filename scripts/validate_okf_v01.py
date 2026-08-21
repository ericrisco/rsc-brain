#!/usr/bin/env python3
"""Independent offline validator for the pinned Open Knowledge Format v0.1 concept contract.

This gate intentionally imports no rsc_brain code. Its normative source is the byte-pinned upstream
SPEC.md next to PROVENANCE.json; product and gate therefore cannot agree merely by sharing an
implementation mistake.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import yaml

EXPECTED_COMMIT = "d44368c15e38e7c92481c5992e4f9b5b421a801d"
EXPECTED_SPEC_SHA256 = "b9655e607346dbbdc6de21190e9a953313eda6a7eba68d4d272a65975940ad6e"


class _StringTimestampSafeLoader(yaml.SafeLoader):
    pass


_StringTimestampSafeLoader.yaml_implicit_resolvers = {
    first: [(tag, pattern) for tag, pattern in resolvers if tag != "tag:yaml.org,2002:timestamp"]
    for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}


def _load_reference(reference: Path) -> None:
    provenance = json.loads((reference / "PROVENANCE.json").read_text(encoding="utf-8"))
    if provenance.get("upstream_commit") != EXPECTED_COMMIT:
        raise ValueError("reference: upstream commit does not match the pinned OKF v0.1 revision")
    digest = hashlib.sha256((reference / "SPEC.md").read_bytes()).hexdigest()
    if digest != EXPECTED_SPEC_SHA256 or provenance.get("spec_sha256") != digest:
        raise ValueError("reference: SPEC.md checksum does not match pinned OKF v0.1 bytes")


def _load_concept(path: Path) -> dict[str, object]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        raise ValueError("frontmatter: concept must begin with '---'")
    parts = text.split("---", 2)
    if len(parts) != 3:
        raise ValueError("frontmatter: unterminated block")
    data = yaml.load(parts[1], Loader=_StringTimestampSafeLoader)  # noqa: S506
    if not isinstance(data, dict) or any(not isinstance(key, str) for key in data):
        raise ValueError("frontmatter: required string-keyed mapping")
    return data


def _validate(concept: dict[str, object]) -> None:
    concept_type = concept.get("type")
    if not isinstance(concept_type, str) or not concept_type.strip():
        raise ValueError("type: required non-empty string (OKF v0.1 §4.1)")
    for key in ("title", "description", "resource", "timestamp"):
        if key in concept and not isinstance(concept[key], str):
            raise ValueError(f"{key}: must be a string when present (OKF v0.1 §4.1)")
    if "tags" in concept and (
        not isinstance(concept["tags"], list)
        or any(not isinstance(tag, str) for tag in concept["tags"])
    ):
        raise ValueError("tags: must be a list of strings (OKF v0.1 §4.1)")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("concept", type=Path)
    parser.add_argument("--reference", required=True, type=Path)
    args = parser.parse_args()
    try:
        _load_reference(args.reference)
        _validate(_load_concept(args.concept))
    except (OSError, ValueError, json.JSONDecodeError, yaml.YAMLError) as exc:
        print(f"OKF v0.1 invalid: {exc}", file=sys.stderr)
        return 1
    print("OKF v0.1 valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
