"""CI guard (SPEC-23, E11.1): service code emits structured logs, never bare ``print``."""

from __future__ import annotations

import re
from pathlib import Path

_SRC = Path(__file__).resolve().parents[2] / "src" / "rsc_brain"
_PRINT = re.compile(r"(?<![A-Za-z_.])print\s*\(")


def test_no_bare_print_in_service_code() -> None:
    offenders: list[str] = []
    for path in _SRC.rglob("*.py"):
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            stripped = line.lstrip()
            if stripped.startswith("#"):
                continue
            if _PRINT.search(line):
                offenders.append(f"{path.relative_to(_SRC)}:{number}")
    assert not offenders, f"use structlog / typer.echo, not print: {offenders}"
