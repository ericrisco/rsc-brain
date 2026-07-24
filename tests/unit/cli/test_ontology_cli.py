"""CLI tests for `brain ontology validate` + registration (SPEC-24, FR-17.1). No DB needed."""

from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from rsc_brain.cli.main import app

runner = CliRunner()

VALID = """
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix ex: <http://example.org/#> .
ex:Contract a owl:Class ; rdfs:label "contract" .
"""


def test_ontology_group_registered() -> None:
    result = runner.invoke(app, ["ontology", "--help"])
    assert result.exit_code == 0
    for sub in ("add", "list", "validate", "coverage"):
        assert sub in result.stdout


def test_validate_valid_file(tmp_path: Path) -> None:
    path = tmp_path / "onto.ttl"
    path.write_text(VALID, encoding="utf-8")
    result = runner.invoke(app, ["ontology", "validate", str(path), "--json"])
    assert result.exit_code == 0
    payload = json.loads(result.stdout)
    assert payload["status"] == "valid"
    assert payload["triples"] > 0


def test_validate_invalid_file(tmp_path: Path) -> None:
    path = tmp_path / "broken.ttl"
    path.write_text("@@@ not turtle ;;;", encoding="utf-8")
    result = runner.invoke(app, ["ontology", "validate", str(path), "--json"])
    assert result.exit_code == 1
    payload = json.loads(result.stdout)
    assert payload["status"] == "invalid"


def test_validate_missing_file(tmp_path: Path) -> None:
    result = runner.invoke(app, ["ontology", "validate", str(tmp_path / "nope.ttl")])
    assert result.exit_code == 2


def test_export_has_rdf_flag() -> None:
    result = runner.invoke(app, ["export", "--help"])
    assert result.exit_code == 0
    assert "--rdf" in result.stdout
