"""AUDIT-098: the eval corpus named four users and defined none of them.

`evals/golden.yaml` said, in its header:

    Users & memberships are defined in evals/README.md.

The README mentions none of them — zero occurrences of alice, bob, dave, erin or "membership". The
four names existed only as opaque strings inside golden.yaml itself.

**What that cost.** The `denied` (6 cases) and `cross_project` (5 cases) families are defined
*entirely* by which topics each principal may see: a denied case is only a denied case because the
asking user lacks the topic. Without the memberships, 11 of 47 cases cannot be run, and **G2 — zero
permission leaks — is not measurable from this corpus** by anyone who is not its author, working from
memory.

**Why the pointer made it worse.** A missing definition is a gap someone eventually trips over. A
pointer that asserts the definition exists stops the reader looking for it. That is the same shape as
release-identity's "assumed yes unless objected" (AUDIT-094) and the parity guard's header teaching
the command that disarms it (AUDIT-097).

The memberships in `users.yaml` are a **reconstruction**, not a recovery. Only bob's is pinned by
evidence — golden.yaml's own comment says the denied family is a "general-only user asks about
sensitive". The rest follow from the families needing to be meaningful, and the tests below are what
make the reconstruction checkable instead of asserted: every principal defined, every topic real, every
non-cross-project case asking inside its own project, and each permission family actually exercising
the property it is named for.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

EVALS = Path(__file__).resolve().parents[2] / "evals"


def _load(name: str) -> dict[str, Any]:
    parsed: dict[str, Any] = yaml.safe_load((EVALS / name).read_text(encoding="utf-8"))
    return parsed


def _users() -> dict[str, Any]:
    users: dict[str, Any] = _load("users.yaml")["users"]
    return users


def _cases() -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = _load("golden.yaml")["cases"]
    return cases


def _topics_by_project() -> dict[str, dict[str, int]]:
    projects = _load("taxonomy.yaml")["projects"]
    return {
        slug: {t["slug"]: t["sensitivity"] for t in project["topics"]}
        for slug, project in projects.items()
    }


def test_every_principal_the_golden_set_uses_is_defined() -> None:
    """The regression. 11 of 47 cases were unrunnable because these four were nowhere."""
    named = {case["user"] for case in _cases()}
    defined = set(_users())
    missing = named - defined
    assert not missing, (
        f"the golden set asks as {sorted(missing)} and nothing defines their memberships, so the "
        "permission families cannot be run and G2 is not measurable from this corpus"
    )


def test_no_principal_is_defined_but_unused() -> None:
    """The other direction: a principal nobody asks as is a membership nobody validates."""
    orphans = set(_users()) - {case["user"] for case in _cases()}
    assert not orphans, f"{sorted(orphans)} are defined and never used"


def test_every_granted_topic_exists_in_that_project() -> None:
    """A grant naming a topic the taxonomy does not have silently grants nothing."""
    topics = _topics_by_project()
    problems = []
    for name, user in _users().items():
        known = set(topics[user["project"]])
        unknown = set(user["allowed_topics"]) - known
        if unknown:
            problems.append(f"{name} is granted {sorted(unknown)}, absent from {user['project']}")
    assert not problems, "\n  ".join(problems)


def test_each_case_asks_inside_its_own_project_unless_it_is_a_cross_project_case() -> None:
    """A `hit` case whose principal belongs to the other project fails for the wrong reason, and
    would be read as a retrieval failure."""
    users = _users()
    wrong = [
        f"{case['id']} ({case['family']}): {case['user']} is in {users[case['user']]['project']}, "
        f"case is {case['project']}"
        for case in _cases()
        if case["family"] != "cross_project" and users[case["user"]]["project"] != case["project"]
    ]
    assert not wrong, "\n  ".join(wrong)


def test_the_denied_family_is_actually_denied_by_the_memberships() -> None:
    """The reconstruction has to make the family MEAN something.

    A denied case must be asked by a principal who lacks at least one sensitive topic in that project
    — otherwise the corpus contains six cases that prove nothing, and a run reporting "zero permission
    leaks" is reporting that it asked no restricted question.
    """
    users, topics = _users(), _topics_by_project()
    toothless = []
    for case in _cases():
        if case["family"] != "denied":
            continue
        user = users[case["user"]]
        # FR-4.14: sensitivity >= 3 is the restrictive threshold.
        restricted = {s for s, sens in topics[case["project"]].items() if sens >= 3}
        if not restricted - set(user["allowed_topics"]):
            toothless.append(f"{case['id']}: {case['user']} can see every sensitive topic")
    assert not toothless, (
        "these denied cases cannot be denied under the defined memberships:\n  "
        + "\n  ".join(toothless)
    )


def test_no_role_flag_substitutes_for_topic_authority() -> None:
    """R01 / AUDIT-020: a role never implies topic access. If an eval principal could curate, a
    permission case might pass on the flag instead of on the grant, and the corpus would stop
    measuring what it claims to."""
    curators = [name for name, user in _users().items() if user.get("can_curate")]
    assert not curators, (
        f"{sorted(curators)} carry can_curate, so a permission case could be decided by the role "
        "rather than by allowed_topics — which is the confusion R01 exists to prevent"
    )
