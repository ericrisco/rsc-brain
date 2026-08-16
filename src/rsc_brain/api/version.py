"""The version endpoint (SPEC release-identity).

Deliberately the smallest module in the API, and deliberately isolated from the rest of it. Its
contract is that it needs **nothing**: no credential, no database, no model provider, no
configuration. That is what lets it answer when an operator most needs it — while the instance is
degraded and someone is trying to work out which build they are looking at.

Anything added here that can be unavailable breaks the one property the endpoint exists for, so the
tests assert structurally that this module declares no dependency and imports no store or gateway.
That guard is not paranoia: this run has already found a health check that shelled out to a command
which does not contact providers, a documentation gate that passed on an empty inventory, and a
detector that read a field its vendor does not define. A route that quietly grows a dependency would
be the same shape.

It is unauthenticated by an explicit decision recorded in the spec's clarification: monitoring,
support and the upgrade runbook all need it without a credential, and the answer carries the
published version only — never the source revision.
"""

from __future__ import annotations

from fastapi import APIRouter

from rsc_brain.identity_release import public

router = APIRouter(prefix="/api/v1", tags=["version"])


@router.get("/version")
async def read_version() -> dict[str, str]:
    """Which published version this instance is, or that it is not one.

    The answer is the *public form* of the build identity: coarse on purpose. Two different
    development builds answer identically; only `brain --version` separates them.
    """
    return {"version": public()}
