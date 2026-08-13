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
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

#: Keys the installer must not leave blank, because a later phase fails on them.
REQUIRED_SECRETS: tuple[str, ...] = ("POSTGRES_PASSWORD",)

#: The application reads its database location from here. The compose service is configured from
#: POSTGRES_*, so without this the installer generates a password the application cannot use and
#: `brain migrate` stops with DatabaseNotConfiguredError — leaving the operator to hand-assemble a
#: connection string out of three values they never chose.
DSN_KEY = "RSC_BRAIN_DATABASE__DSN"

#: Values that are present but mean "not configured". Treated exactly like a blank.
PLACEHOLDERS: frozenset[str] = frozenset(
    {"", "changeme", "change-me", "password", "postgres", "secret", "todo", "xxx"}
)


#: The application configuration the runtime refuses to start without. `brain migrate` loads full
#: settings — including model capabilities it never uses — so without this file a *database*
#: migration fails on a *model* validation error. Materialising the shipped example is what makes
#: the install a single command; the operator still edits the model routes before the terminal
#: verify can pass.
CONFIG_FILE = "config.yaml"
CONFIG_TEMPLATE = "config.example.yaml"


@dataclass(frozen=True, slots=True)
class EnvReport:
    """What `materialise` did, so the CLI can print it without re-reading the file."""

    created: bool
    generated: tuple[str, ...]
    already_set: tuple[str, ...]
    config_created: bool = False

    def explain(self) -> str:
        parts: list[str] = []
        parts.append(".env created from the template" if self.created else ".env already present")
        if self.generated:
            parts.append(f"generated {', '.join(self.generated)}")
        if self.already_set:
            parts.append(f"kept existing {', '.join(self.already_set)}")
        parts.append(
            f"{CONFIG_FILE} created from {CONFIG_TEMPLATE}"
            if self.config_created
            else f"{CONFIG_FILE} already present"
        )
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


def _derive_dsn(values: Mapping[str, str]) -> str:
    """Compose the DSN from what the compose service was just configured with.

    The password is percent-encoded: it is generated URL-safe today, but an operator may set their
    own, and a `@` or `/` in a password silently produces a DSN that points somewhere else.
    """
    user = values.get("POSTGRES_USER") or "rsc_brain"
    database = values.get("POSTGRES_DB") or "rsc_brain"
    password = quote(values.get("POSTGRES_PASSWORD", ""), safe="")
    host = values.get("RSC_BRAIN_DB_BIND") or "127.0.0.1"
    port = values.get("RSC_BRAIN_DB_PORT") or "5432"
    return f"postgresql+asyncpg://{user}:{password}@{host}:{port}/{database}"


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

    # The DSN is derived, never invented: it must agree with the POSTGRES_* values above, and it
    # is only written when the operator has not already pointed the app at their own database.
    values = _parse(text)
    if _is_unset(values.get(DSN_KEY)):
        dsn = _derive_dsn(values)
        if DSN_KEY in values:
            text = (
                "\n".join(
                    f"{DSN_KEY}={dsn}" if line.split("=", 1)[0].strip() == DSN_KEY else line
                    for line in text.splitlines()
                )
                + "\n"
            )
        else:
            text = text.rstrip("\n") + f"\n{DSN_KEY}={dsn}\n"
        generated.append(DSN_KEY)
    else:
        already.append(DSN_KEY)

    env_path.write_text(text, encoding="utf-8")
    env_path.chmod(0o600)

    config_created = False
    config_path = root / CONFIG_FILE
    if not config_path.exists():
        template = root / CONFIG_TEMPLATE
        if template.exists():
            config_path.write_text(template.read_text(encoding="utf-8"), encoding="utf-8")
            config_created = True

    return EnvReport(
        created=created,
        generated=tuple(generated),
        already_set=tuple(already),
        config_created=config_created,
    )


def check(root: Path) -> tuple[bool, str]:
    """Are the required secrets usable? This is what the ``config`` phase's verify must ask."""
    env_path = root / ".env"
    if not env_path.exists():
        return False, f"{env_path.name} does not exist"
    values = _parse(env_path.read_text(encoding="utf-8"))
    unset = [key for key in REQUIRED_SECRETS if _is_unset(values.get(key))]
    if unset:
        return False, f"unset or placeholder: {', '.join(unset)}"
    if _is_unset(values.get(DSN_KEY)):
        return False, f"{DSN_KEY} is unset — the application cannot reach the database"
    if not (root / CONFIG_FILE).exists():
        return False, f"{CONFIG_FILE} is missing — the runtime cannot load its settings without it"
    return True, f"secrets set, {DSN_KEY} derived, and {CONFIG_FILE} present"
