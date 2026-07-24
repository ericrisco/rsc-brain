"""Frozen ``Channel`` interface for hunting. Implemented in SPEC-15.

A channel delivers a hunting question to a responsible person and collects the answer via a
magic-link token. Sending is project-scoped; the token maps an inbound reply back to its hunt
without exposing project internals.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from rsc_brain.scope import ProjectScope


@dataclass(frozen=True, slots=True)
class OutboundMessage:
    to: str
    subject: str
    body: str
    reply_token: str


@dataclass(frozen=True, slots=True)
class InboundMessage:
    reply_token: str
    body: str


class Channel(Protocol):
    """Send/receive contract for a hunting channel (email/Slack, v0.3)."""

    async def send(self, scope: ProjectScope, message: OutboundMessage) -> str:
        """Deliver ``message`` within ``scope``; return a provider message id."""
        ...

    async def receive(self, reply_token: str) -> InboundMessage | None:
        """Resolve an inbound reply for ``reply_token``, or ``None`` if none/invalid."""
        ...
