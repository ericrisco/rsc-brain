"""Build a hunt service from configuration (AUDIT-042 / R28).

The admin surface used to call ``HuntService(sessionmaker)``: no channel, so every hunt went to the
recorder that sends nothing, and no base URL, so every reply link pointed at ``https://brain.local`` —
a host that does not exist. Hunting reported success and could not complete a single loop.

Everything that decides whether a hunt can actually reach a person is therefore resolved here, once,
and both the API and the CLI go through it.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.config.models import HuntingConfig
from rsc_brain.hunting.channels import (
    Channel,
    NullChannel,
    SlackChannel,
    SlackSettings,
    SmtpChannel,
    SmtpSettings,
)
from rsc_brain.hunting.service import HuntService

#: Where the reply form lives, relative to the install's own origin. One definition: the link the
#: message carries and the route that serves it have to agree, and they used not to.
HUNT_ANSWER_PATH = "/hunt"


def build_channel(
    channel: str | None,
    *,
    smtp: Mapping[str, Any] | None = None,
    slack: Mapping[str, Any] | None = None,
) -> tuple[Channel, bool]:
    """The configured channel and whether it can actually deliver.

    ``(NullChannel(), False)`` when nothing is configured — and the *False* is the point: the caller
    must report an undelivered hunt rather than an asked one, so an unconfigured install is
    distinguishable from a working one.
    """
    if channel in {None, "", "none", "null"}:
        return NullChannel(), False
    if channel == "smtp":
        if not smtp or not smtp.get("host"):
            raise ValueError("hunting.channel is 'smtp' but no SMTP host is configured")
        return SmtpChannel(SmtpSettings(**dict(smtp))), True
    if channel == "slack":
        if not slack or not slack.get("bot_token"):
            raise ValueError("hunting.channel is 'slack' but no bot token is configured")
        return SlackChannel(SlackSettings(**dict(slack))), True
    raise ValueError(f"unknown hunting channel {channel!r}")


def build_channel_from_config(config: object) -> tuple[Channel, bool]:
    """Resolve the one configured outreach channel for any production consumer."""
    return build_channel(
        config.channel,  # type: ignore[attr-defined]
        smtp=_secrets(config.smtp),  # type: ignore[attr-defined]
        slack=_secrets(config.slack),  # type: ignore[attr-defined]
    )


def build_hunt_service(
    sessionmaker: async_sessionmaker[AsyncSession],
    *,
    channel: str | None = None,
    smtp: Mapping[str, Any] | None = None,
    slack: Mapping[str, Any] | None = None,
    public_origin: str | None = None,
    gateway: object | None = None,
) -> HuntService:
    """The hunt service as an install must run it.

    ``public_origin`` is the origin clients actually reach (the same deployment fact OAuth metadata
    uses, AUDIT-038): a magic link is worthless unless it points at the install's own host.
    """
    delivery, can_deliver = build_channel(channel, smtp=smtp, slack=slack)
    return HuntService(
        sessionmaker,
        channel=delivery,
        gateway=gateway,
        base_url=public_origin or HuntService.UNCONFIGURED_BASE_URL,
        can_deliver=can_deliver,
    )


def build_hunt_service_from_settings(
    sessionmaker: async_sessionmaker[AsyncSession], *, gateway: object | None = None
) -> HuntService:
    """The configured service for a process that has configuration but no app state (CLI, MCP tool).

    When configuration cannot be loaded at all — a test harness with no config file — the service is
    built unconfigured. That is not a silent fallback: an unconfigured service reports its hunts as
    undelivered, which is exactly what an install in that state should say.
    """
    try:
        from rsc_brain.config import load_settings

        settings = load_settings()
    except Exception:
        return build_hunt_service(sessionmaker, channel=None, gateway=gateway)
    return build_hunt_service_from_config(
        sessionmaker,
        hunting=settings.hunting,
        public_origin=settings.ingress.public_origin,
        gateway=gateway,
    )


def build_hunt_service_from_config(
    sessionmaker: async_sessionmaker[AsyncSession],
    *,
    hunting: HuntingConfig,
    public_origin: str | None,
    gateway: object | None = None,
) -> HuntService:
    """Build from an already-loaded runtime graph and unwrap secrets at the channel boundary."""
    return build_hunt_service(
        sessionmaker,
        channel=hunting.channel,
        smtp=_secrets(hunting.smtp),
        slack=_secrets(hunting.slack),
        public_origin=public_origin,
        gateway=gateway,
    )


def _secrets(config: object | None) -> dict[str, Any] | None:
    """Channel settings as plain values, unwrapping the secrets exactly where they are used."""
    if config is None:
        return None
    dumped = config.model_dump()  # type: ignore[attr-defined]
    return {
        key: (value.get_secret_value() if hasattr(value, "get_secret_value") else value)
        for key, value in dumped.items()
    }
