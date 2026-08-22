"""The upgrade runbook may not teach a version change without the checkout that makes it work.

AUDIT-137 stated the coupling in `deploy/docker-compose.version.yml`. That fix was half of one: the
runbook that tells an operator to *change* the pinned version is `docs/how-to/upgrade.md`, and
upgrading — or rolling back — is precisely the act of pointing an existing checkout at a different
image. It said "Rolling back is the same command with the previous version", which is the pairing
measured to crash-loop the API:

    capabilities.embedder.egress — Extra inputs are not permitted [type=extra_forbidden]

A newer compose file against an older image. So the documented rollback would fail in the one
situation it exists for — mid-incident — and the message names a config field, not a version mismatch.

The runbook also named `0.13.0` concretely in its Helm example, for which no image has ever been
published (only `v0.13.1-rc1` and `v0.13.1-rc2` have images, both predating the current chart's
capability environment). Same rule as the compose file: parametric until a released version is
pullable.
"""

from __future__ import annotations

import re
from pathlib import Path

RUNBOOK = Path(__file__).resolve().parents[3] / "docs" / "how-to" / "upgrade.md"


def test_no_pinned_version_is_named_concretely() -> None:
    text = RUNBOOK.read_text()
    concrete = [
        pinned
        for pinned in re.findall(r"(?:RSC_BRAIN_VERSION=|--set image\.tag=)([\w.\-+<>]+)", text)
        if re.match(r"^v?\d", pinned)
    ]
    assert not concrete, (
        f"the runbook pins {concrete} concretely. Every concrete version it could name today is "
        "either foreign to the reader's checkout (crash loop) or unpublished (pull failure)."
    )


def test_both_paths_show_the_checkout_that_makes_the_pin_work() -> None:
    """Compose and Helm each get their own step: an operator follows one section, not the document."""
    text = RUNBOOK.read_text()
    compose_section = text.split("## Upgrade a Compose deployment", 1)[1].split(
        "## Upgrade a Helm", 1
    )[0]
    helm_section = text.split("## Upgrade a Helm deployment", 1)[1]
    assert "git checkout" in compose_section, "the Compose path must show the tag checkout"
    assert "git checkout" in helm_section, (
        "the Helm path must show it too; the chart travels as well"
    )


def test_the_rollback_promise_names_its_own_trap() -> None:
    """The sentence that used to be wrong has to stay explicit about what it now requires."""
    text = RUNBOOK.read_text()
    rollback = [line for line in text.splitlines() if "Rolling back is the same command" in line]
    assert rollback, "the rollback instruction must survive; deleting it is not a fix"
    following = text.split("Rolling back is the same command", 1)[1][:400]
    assert "tag" in following, "rolling back has to name the tag, not only the version"
