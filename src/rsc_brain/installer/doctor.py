"""`brain doctor` — hardcoded-secret scan of configuration files (SPEC-04 part, FR-4.7).

Flags populated secret assignments (`api_key: sk-…`, `password: …`, `dsn: …`) and known
key-shaped tokens in tracked config, so real credentials never live in `config.yaml`. Obvious
placeholders (empty, `change_me`, `<…>`, `${…}`, `example`) are ignored. This is a config
hygiene check, NOT a full secret scanner (that gate is SPEC-22).
"""

from __future__ import annotations

import os
import re
from collections.abc import Iterable, Mapping
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


def detect_tls(env: Mapping[str, str] | None = None) -> dict[str, object]:
    """Report the TLS front (FR-4.8). A public ``RSC_BRAIN_DOMAIN`` ⇒ Caddy can serve HTTPS
    (`--profile tls`); its absence ⇒ Claude/ChatGPT will NOT connect (HTTPS is a hard OAuth
    prerequisite, D11) — surfaced as a warning, not a secret finding."""
    source = os.environ if env is None else env
    domain = source.get("RSC_BRAIN_DOMAIN", "").strip()
    configured = bool(domain) and domain != "localhost"
    return {
        "domain": domain or None,
        "configured": configured,
        "warning": None
        if configured
        else "No public RSC_BRAIN_DOMAIN set: run `docker compose --profile tls up` with a "
        "domain, or Claude/ChatGPT cannot connect (HTTPS is required for OAuth).",
    }


@dataclass(frozen=True, slots=True)
class DoctorReport:
    """Combined host detection + secret scan (FR-11.1). ``ok`` is false if secrets were found."""

    recommended_profile: str
    host: dict[str, object]
    secret_findings: list[SecretFinding]
    tls: dict[str, object]

    @property
    def ok(self) -> bool:
        return not self.secret_findings


def run_doctor(config_paths: Iterable[Path]) -> DoctorReport:
    """Detect the host, recommend a profile, scan config for hardcoded secrets, report TLS mode."""
    from rsc_brain.installer.host import detect_host

    host = detect_host()
    findings = scan_paths(config_paths)
    return DoctorReport(
        recommended_profile=host.recommended_profile,
        host={
            "docker": host.docker,
            "has_gpu": host.has_gpu,
            "gpu_name": host.gpu_name,
            "vram_mb": host.vram_mb,
            "ram_gb": host.ram_gb,
            "free_ports": host.free_ports,
        },
        secret_findings=findings,
        tls=detect_tls(),
    )
