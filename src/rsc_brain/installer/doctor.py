"""`brain doctor` — hardcoded-secret scan of configuration files (SPEC-04 part, FR-4.7).

Flags populated secret assignments (`api_key: sk-…`, `password: …`, `dsn: …`) and known
key-shaped tokens in tracked config, so real credentials never live in `config.yaml`. Obvious
placeholders (empty, `change_me`, `<…>`, `${…}`, `example`) are ignored. This is a config
hygiene check, NOT a full secret scanner (that gate is SPEC-22).
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

_ASSIGNMENT = re.compile(
    r"(?i)\b(api_key|apikey|password|passwd|secret|token|dsn)\b\s*[:=]\s*[\"']?(?P<val>[^\s\"'#]+)"
)
_KEY_SHAPED = re.compile(r"(sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,})")
_PLACEHOLDER = re.compile(
    r"(?i)^(null|none|change[_-]?me|your[_-].*|<.*>|example.*|placeholder.*|\$\{.*)$"
)


@dataclass(frozen=True, slots=True)
class SecretFinding:
    path: str
    line: int
    reason: str


def scan_text(path: str, text: str) -> list[SecretFinding]:
    findings: list[SecretFinding] = []
    for number, raw in enumerate(text.splitlines(), start=1):
        if raw.lstrip().startswith("#"):
            continue
        assignment = _ASSIGNMENT.search(raw)
        if assignment and not _PLACEHOLDER.match(assignment.group("val")):
            findings.append(SecretFinding(path, number, f"populated {assignment.group(1).lower()}"))
        if _KEY_SHAPED.search(raw):
            findings.append(SecretFinding(path, number, "key-shaped token"))
    return findings


def scan_paths(paths: Iterable[Path]) -> list[SecretFinding]:
    findings: list[SecretFinding] = []
    for path in paths:
        if path.is_file():
            findings.extend(scan_text(str(path), path.read_text(encoding="utf-8", errors="ignore")))
    return findings
