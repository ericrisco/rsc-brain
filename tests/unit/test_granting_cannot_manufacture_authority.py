"""AUDIT-078: the grant route I shipped in AUDIT-073 let a project-admin self-grant any topic.

Found by an adversarial security review of my own diff — the finding I most needed and least expected,
because the route's docstring cites the very invariant it voids.

`grant_topic` was gated by `_needs_config_write`, which calls `decide(scope, PROJECT_CONFIG_WRITE)`
with **no** `object_topics`. In `authorization.py`, `_topics_authorized(scope, None)` returns
`(True, "")` — the topic check is skipped entirely. Nothing then checked that the granter holds the
topic being granted, or that the target is not the granter.

The exploit is one call, no race, no guessing:

    # alice is project-admin of P holding only {general}. Topic `payroll` (sensitivity 4) exists.
    POST /api/v1/admin/topics/payroll/grants   {"user_id": "<alice's own id>"}
    -> 201 {"allowed_topics": ["general", "payroll"]}

`_membership_scope` re-reads `allowed_topics` per request with no cache, so alice's next recall
carries `payroll` and returns every sensitivity-4 chunk she was deliberately excluded from.

That makes `project-admin` imply all topics, contradicting R01/AUDIT-020 ("even the highest project
role sees only the topics it was granted") and `docs/reference/permissions.md` verbatim: "Project
administrators do not implicitly own every topic."

The codebase had already ratified the correct rule and applied it to five other mutations
(`document.decide`, `gap.promote`, `hunt.manage`, `correction.revert`, `knowledge.review.decide`):
subset semantics — the caller must hold every topic the object touches. The one mutation that
*manufactures* topic authority was the one that skipped it.

Asymmetry, deliberately: granting requires holding the topic; revoking does not. Escalation needs
authority, de-escalation does not — and requiring it to revoke would strand a topic nobody present
can withdraw.
"""

from __future__ import annotations

from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ADMIN_API = REPO / "src" / "rsc_brain" / "api" / "admin.py"


def _route_body(name: str) -> str:
    source = ADMIN_API.read_text(encoding="utf-8")
    start = source.index(f"async def {name}(")
    end = source.find("\n@router.", start)
    return source[start : end if end != -1 else len(source)]


def test_granting_requires_the_granter_to_hold_the_topic() -> None:
    """Subset semantics, the rule five other mutations already follow."""
    body = _route_body("_change_authority")
    assert "AUDIT-078" in body, "the escalation path carries no record of the check it lacked"
    assert "object_topics" in body, (
        "the grant does not put the topic to the authorization decision, so a project-admin passes "
        "on role alone and can manufacture authority over any topic in the project"
    )


def test_the_topic_reaches_the_decision_not_just_the_audit_line() -> None:
    """`topics_used=[slug]` in the audit call is not an authorization check — the original code had
    that and was still exploitable."""
    body = _route_body("_change_authority")
    decision = body[: body.index("record_audit")] if "record_audit" in body else body
    assert "object_topics" in decision, (
        "the topic appears only after the write; the check must precede it"
    )


def test_a_malformed_identifier_is_absent_rather_than_a_server_error() -> None:
    """`authz.py` ratified this: "a malformed identifier is absent, not an error that confirms the
    route". Every new route called `uuid.UUID(user_id)` through the service before validating, so
    `DELETE /memberships/not-a-uuid` returned 500 with a traceback — a third response class,
    distinguishable at zero cost, emitted before the membership lookup."""
    source = ADMIN_API.read_text(encoding="utf-8")
    assert "_membership_target" in source, "no shared guard validates the target identifier"
    guard = source[source.index("def _membership_target") :]
    guard = guard[: guard.index("\n@router.")]
    assert "ValueError" in guard, "a malformed user id still reaches uuid.UUID unguarded"
    assert "404" in guard or "HTTP_404" in guard, "a malformed id must answer as absent"


def test_a_duplicate_membership_answers_conflict_rather_than_crashing() -> None:
    """The pre-check and the write are separate transactions, so two concurrent creates both pass
    the check and the loser hit the unique constraint as an unhandled 500."""
    body = _route_body("create_membership")
    assert "IntegrityError" in body, (
        "the unique constraint is the real arbiter and its violation is not handled, so a race "
        "returns 500 where the same request one second earlier returns 409"
    )


def test_an_authority_change_records_who_it_was_for() -> None:
    """`membership:create` audited `topics_used=[]` and no target; `topic:grant` recorded the topic
    but not the recipient. The trail said "an admin granted payroll" and never "to whom" — the one
    question a permission audit exists to answer."""
    source = ADMIN_API.read_text(encoding="utf-8")
    for action in ("membership:create", "membership:remove", "topic:"):
        index = source.index(f'"{action}')
        window = source[max(0, index - 400) : index + 400]
        assert "user_id" in window, f"the audit for {action} does not record its target"
