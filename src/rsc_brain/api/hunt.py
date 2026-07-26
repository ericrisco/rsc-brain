"""The hunt reply path: a one-time magic link (AUDIT-042 / R28, FR-6.4).

``HuntService.answer_via_magic_link`` and ``decline_via_magic_link`` existed and nothing HTTP reached
them, so the link every hunt message carried resolved to nothing. A person asked for knowledge could
not answer, which means the mechanism meant to stop the product from guessing never closed a loop.

The token IS the credential, so these routes are deliberately unauthenticated — and therefore treated
as hostile input:

* an unknown, expired or already-used token gets one constant answer, so the endpoint cannot be used to
  discover which tokens exist;
* the answer is bounded by the ratified free-text limit, because an unauthenticated body is the last
  place to accept an unbounded one;
* nothing about the project, the person or the question is disclosed until the token proves valid.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Form, HTTPException, Request, status
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, ConfigDict, Field

from rsc_brain.config.models import PublicLimits
from rsc_brain.hunting.service import HuntOutcome, HuntService

router = APIRouter(prefix="/hunt", tags=["hunt"])

_LIMITS = PublicLimits()
_UNKNOWN = "This link is no longer valid. It may have been used already, or it may have expired."


class HuntAnswer(BaseModel):
    """A JSON answer, for a client that is not the browser form."""

    model_config = ConfigDict(extra="forbid")

    answer: str = Field(min_length=1, max_length=_LIMITS.free_text_bytes)
    decline: bool = False


def _service(request: Request) -> HuntService:
    """The hunt service the app was built with (configured channel + real public origin)."""
    service = request.app.state.hunts
    if not isinstance(service, HuntService):  # pragma: no cover - a composition error, not input
        raise RuntimeError("the application was built without a hunt service")
    return service


def _page(body: str) -> HTMLResponse:
    return HTMLResponse(
        "<!doctype html><meta charset=utf-8>"
        "<meta name=viewport content='width=device-width,initial-scale=1'>"
        "<title>rsc-brain</title>"
        "<style>body{font:16px/1.5 system-ui;margin:0 auto;max-width:38rem;padding:2rem}"
        "textarea{width:100%;min-height:8rem}button{padding:.6rem 1rem;margin-right:.5rem}</style>"
        f"{body}"
    )


@router.get("/{token}", include_in_schema=False)
async def answer_form(token: str, request: Request) -> HTMLResponse:
    """Show the question behind a valid token, or one constant refusal for anything else."""
    hunt = await _service(request).hunt_for_token(token)
    if hunt is None:
        return _page(f"<h1>Link expired</h1><p>{_UNKNOWN}</p>")
    question = hunt["question"] or "(no question recorded)"
    return _page(
        f"<h1>rsc-brain needs your knowledge</h1><p>{question}</p>"
        f'<form method=post action="/hunt/{token}">'
        f'<textarea name=answer maxlength="{_LIMITS.free_text_bytes}" '
        'placeholder="Your answer"></textarea><p>'
        "<button name=decline value=false type=submit>Send answer</button>"
        "<button name=decline value=true type=submit>I cannot answer this</button></p></form>"
    )


@router.post("/{token}", include_in_schema=False)
async def submit_form(
    token: str,
    request: Request,
    answer: Annotated[str, Form(max_length=_LIMITS.free_text_bytes)] = "",
    decline: Annotated[str, Form()] = "false",
) -> HTMLResponse:
    """Accept the answer (or the decline) from the browser form."""
    outcome = await _resolve(request, token, answer=answer, declined=decline == "true")
    if outcome is None:
        return _page(f"<h1>Link expired</h1><p>{_UNKNOWN}</p>")
    return _page("<h1>Thank you</h1><p>Your response has been recorded.</p>")


@router.post("/{token}/answer")
async def submit_json(token: str, body: HuntAnswer, request: Request) -> dict[str, object]:
    """The same operation for a non-browser client. 404 for any token that does not resolve."""
    outcome = await _resolve(request, token, answer=body.answer, declined=body.decline)
    if outcome is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_UNKNOWN)
    return {"hunt_id": outcome.hunt_id, "state": str(outcome.state)}


async def _resolve(
    request: Request, token: str, *, answer: str, declined: bool
) -> HuntOutcome | None:
    service = _service(request)
    if declined:
        return await service.decline_via_magic_link(token)
    if not answer.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="an answer is required"
        )
    return await service.answer_via_magic_link(token, answer)
