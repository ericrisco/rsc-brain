"""Materialise a usable ``.env`` for the phased installer (AUDIT-051).

The ``config`` phase used to run ``cp -n .env.example .env`` and verify with ``test -f .env``. On a
clean host that reports **success** while leaving ``POSTGRES_PASSWORD=`` empty — and the very next
phase refuses to start, because the data service rejects a blank password. A phase that reports
success has to leave the install one step better off, so this module fills the blanks instead of
copying them.

Two properties matter more than the convenience:

* **Idempotent.** A value that is already set is never touched, so re-running ``brain apply`` on a
  live install cannot rotate the database password out from under the running database.
* **Checkable.** ``check`` answers the question the phase's verify actually needs — *are the
  required secrets usable* — rather than the question ``test -f`` answers, which is *does a file
  exist*.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from pathlib import Path

#: Keys the installer must not leave blank, because a later phase fails on them.
REQUIRED_SECRETS: tuple[str, ...] = ("POSTGRES_PASSWORD",)

#: Values that are present but mean "not configured". Treated exactly like a blank.
PLACEHOLDERS: frozenset[str] = frozenset(
    {"", "changeme", "change-me", "password", "postgres", "secret", "todo", "xxx"}
)


@dataclass(frozen=True, slots=True)
class EnvReport:
    """What `materialise` did, so the CLI can print it without re-reading the file."""

    created: bool
    generated: tuple[str, ...]
    already_set: tuple[str, ...]

    def explain(self) -> str:
        parts: list[str] = []
        parts.append(".env created from the template" if self.created else ".env already present")
        if self.generated:
            parts.append(f"generated {', '.join(self.generated)}")
        if self.already_set:
            parts.append(f"kept existing {', '.join(self.already_set)}")
        return "; ".join(parts)


def _parse(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        values[key.strip()] = value.strip()
    return values


def _is_unset(value: str | None) -> bool:
    return value is None or value.strip().strip("\"'").lower() in PLACEHOLDERS


def _generate() -> str:
    """A password safe to paste into an env file: URL-safe, no quoting hazards, 32 bytes."""
    return secrets.token_urlsafe(32)


def materialise(root: Path) -> EnvReport:
    """Create ``.env`` from ``.env.example`` if absent, then fill every unset required secret."""
    env_path = root / ".env"
    created = False
    if not env_path.exists():
        template = root / ".env.example"
        if not template.exists():
            raise FileNotFoundError(f"neither {env_path} nor {template} exists")
        env_path.write_text(template.read_text(encoding="utf-8"), encoding="utf-8")
        env_path.chmod(0o600)
        created = True

    text = env_path.read_text(encoding="utf-8")
    values = _parse(text)
    generated: list[str] = []
    already: list[str] = []

    for key in REQUIRED_SECRETS:
        if _is_unset(values.get(key)):
            secret = _generate()
            if key in values:
                lines = [
                    f"{key}={secret}" if line.split("=", 1)[0].strip() == key else line
                    for line in text.splitlines()
                ]
                text = "\n".join(lines) + "\n"
            else:
                text = text.rstrip("\n") + f"\n{key}={secret}\n"
            generated.append(key)
        else:
            already.append(key)

    env_path.write_text(text, encoding="utf-8")
    env_path.chmod(0o600)
    return EnvReport(created=created, generated=tuple(generated), already_set=tuple(already))


def check(root: Path) -> tuple[bool, str]:
    """Are the required secrets usable? This is what the ``config`` phase's verify must ask."""
    env_path = root / ".env"
    if not env_path.exists():
        return False, f"{env_path.name} does not exist"
    values = _parse(env_path.read_text(encoding="utf-8"))
    unset = [key for key in REQUIRED_SECRETS if _is_unset(values.get(key))]
    if unset:
        return False, f"unset or placeholder: {', '.join(unset)}"
    return True, f"every required secret is set ({', '.join(REQUIRED_SECRETS)})"
