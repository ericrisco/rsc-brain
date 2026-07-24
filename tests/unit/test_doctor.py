"""Unit tests for the doctor hardcoded-secret scan (SPEC-04, FR-4.7)."""

from __future__ import annotations

from pathlib import Path

from rsc_brain.installer.doctor import scan_paths, scan_text

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_flags_populated_api_key_and_key_shaped_token() -> None:
    findings = scan_text("config.yaml", "api_key: sk-ABCDEFGH1234567890abcdef\n")
    assert findings
    reasons = {f.reason for f in findings}
    assert any("api_key" in r or "key-shaped" in r for r in reasons)


def test_flags_populated_password() -> None:
    assert scan_text("config.yaml", "password: hunter2-real-value")


def test_ignores_placeholders_and_env_refs() -> None:
    assert scan_text("config.yaml", "api_key: change_me") == []
    assert scan_text("config.yaml", "password: ${DB_PASSWORD}") == []
    assert scan_text("config.yaml", "token: <your-token-here>") == []


def test_ignores_comments() -> None:
    assert scan_text("config.yaml", "# api_key: sk-ABCDEFGH1234567890abcdef") == []


def test_example_config_is_clean() -> None:
    findings = scan_paths([REPO_ROOT / "config.example.yaml"])
    assert findings == [], f"config.example.yaml must carry no secrets, got {findings}"
