"""Hunt delivery channels (SPEC-15, FR-6.4). Frozen ``Channel`` interface (SPEC-01 discipline).

Email (SMTP) and Slack (bot token) both ship; the reply path is a **magic link** to a one-time web
form (the PRD's default — parsing email replies is fragile). Their live credentials are absent in CI,
so the senders themselves are exercised only against a configured install; ``NullChannel`` records what
would be sent so the whole lifecycle is driven + asserted deterministically. ``quiet_hours`` are
honoured by the caller BEFORE handing a message to a channel — a channel just delivers.

R28: for a long time ``NullChannel`` was the ONLY channel and the production factory always chose it,
so every hunt was recorded as sent and delivered nowhere. A recorder is a test seam; it must never be
what an install silently falls back to while reporting success.
"""

from __future__ import annotations

import asyncio
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Protocol

#: Seconds. A delivery that hangs must fail rather than hold the hunt open forever.
_SEND_TIMEOUT = 15.0


@dataclass(frozen=True, slots=True)
class OutboundMessage:
    channel: str
    to: str
    subject: str
    body: str
    magic_link: str | None = None
    # Stable across delivery retries. Slack consumes it natively; SMTP emits it as Message-ID so
    # downstream systems can collapse a crash-window replay (AUDIT-018).
    idempotency_key: str | None = None


class Channel(Protocol):
    @property
    def name(self) -> str: ...

    async def send(self, message: OutboundMessage) -> None: ...


class NullChannel:
    """Records sends without any external call — the CI/dev default and the test seam."""

    def __init__(self) -> None:
        self.sent: list[OutboundMessage] = []

    @property
    def name(self) -> str:
        return "null"

    async def send(self, message: OutboundMessage) -> None:
        self.sent.append(message)


@dataclass(frozen=True, slots=True)
class SmtpSettings:
    host: str
    port: int = 587
    sender: str = "rsc-brain@localhost"
    username: str | None = None
    password: str | None = None
    starttls: bool = True


class SmtpChannel:
    """Email over SMTP (FR-6.4). The password comes from configuration, never from a message."""

    def __init__(self, settings: SmtpSettings) -> None:
        self._settings = settings

    @property
    def name(self) -> str:
        return "smtp"

    async def send(self, message: OutboundMessage) -> None:
        # Sent from a worker thread: `smtplib` is blocking, and a hunt must not stall the event loop
        # of the process that opened it.
        await asyncio.to_thread(self._send_blocking, message)

    def _send_blocking(self, message: OutboundMessage) -> None:
        settings = self._settings
        email = EmailMessage()
        email["From"] = settings.sender
        email["To"] = message.to
        email["Subject"] = message.subject
        if message.idempotency_key:
            email["Message-ID"] = f"<{message.idempotency_key}@rsc-brain>"
        email.set_content(message.body)
        with smtplib.SMTP(settings.host, settings.port, timeout=_SEND_TIMEOUT) as client:
            if settings.starttls:
                client.starttls()
            if settings.username and settings.password:
                client.login(settings.username, settings.password)
            client.send_message(email)


@dataclass(frozen=True, slots=True)
class SlackSettings:
    bot_token: str
    default_channel: str | None = None


class SlackChannel:
    """Slack via `chat.postMessage` (FR-6.4).

    ``message.to`` is the person's Slack id or channel; the configured default is the fallback for a
    person whose directory entry has no Slack handle.
    """

    def __init__(self, settings: SlackSettings) -> None:
        self._settings = settings

    @property
    def name(self) -> str:
        return "slack"

    async def send(self, message: OutboundMessage) -> None:
        import httpx

        target = message.to or self._settings.default_channel
        if not target:
            raise ValueError("no Slack target for this message and no default channel configured")
        async with httpx.AsyncClient(timeout=_SEND_TIMEOUT) as client:
            response = await client.post(
                "https://slack.com/api/chat.postMessage",
                headers={"Authorization": f"Bearer {self._settings.bot_token}"},
                json={
                    "channel": target,
                    "text": f"*{message.subject}*\n{message.body}",
                    **(
                        {"client_msg_id": message.idempotency_key}
                        if message.idempotency_key
                        else {}
                    ),
                },
            )
        response.raise_for_status()
        body = response.json()
        if not body.get("ok"):
            # Slack answers 200 with ok=false; treating that as success is how a delivery failure
            # becomes an "asked" hunt nobody ever received.
            raise RuntimeError(f"slack refused the message: {body.get('error', 'unknown')}")
