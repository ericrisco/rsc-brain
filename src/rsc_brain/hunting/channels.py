"""Hunt delivery channels (SPEC-15, FR-6.4). Frozen ``Channel`` interface (SPEC-01 discipline).

v0.3 targets email (SMTP) and Slack (bot token); the reply path is a **magic link** to a one-time
web form (the PRD's default — parsing email replies is fragile). The live SMTP/Slack senders are
**blocked-by-resource** (no credentials in CI); ``NullChannel`` records what would be sent so the
whole lifecycle is driven + asserted deterministically. ``quiet_hours`` are honoured by the caller
BEFORE handing a message to a channel — a channel just delivers.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True, slots=True)
class OutboundMessage:
    channel: str
    to: str
    subject: str
    body: str
    magic_link: str | None = None


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
