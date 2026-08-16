"""AUDIT-093: the install-by-version topology named an image nobody publishes.

Found by installing the first published version on a clean host. The application and the console
pulled anonymously and the application reported `v0.13.1-rc1` — the identity had reached the
artifact. Then:

    Image ghcr.io/ericrisco/rsc-brain/db:pg16-age-pgvector Error error from registry: denied

Clarify decided the data component is published "only when it changes", because it is Postgres with
two extensions and moves far more slowly than the application. **I implemented "only when it
changes" as never.** The topology named a tag, the release published two of the three images, and
installing by version was impossible for anyone who tried it.

The failure mode is this run's constant one — a declaration that points at nothing — and it is
exactly what the reranker route (AUDIT-077), the reranker switch (AUDIT-084) and the OCR language
configuration (AUDIT-087) each turned out to be. It survived every test in the repository because
every one of them reads files, and the missing thing was in a registry.

This test closes the class rather than the instance: **every image the shipped topology names must
be one the release publishes.** It compares the two sets and fails on any name in the first that is
absent from the second, so a fourth component added later cannot repeat it.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[2]
TOPOLOGY = REPO / "deploy" / "docker-compose.version.yml"
WORKFLOW = REPO / ".github" / "workflows" / "release.yml"

#: Images the product does not build and must not try to publish.
THIRD_PARTY = ("caddy", "busybox", "ollama/ollama", "postgres:")


def _named_by_the_topology() -> set[str]:
    """Every first-party image reference in the install-by-version topology, without its tag."""
    services = yaml.safe_load(TOPOLOGY.read_text(encoding="utf-8")).get("services", {})
    names = set()
    for service in services.values():
        image = (service or {}).get("image")
        if not isinstance(image, str) or any(vendor in image for vendor in THIRD_PARTY):
            continue
        # Strip the tag, which may be a `${VAR:-default}` interpolation containing colons.
        names.add(re.sub(r":\$?\{?[^/]*$", "", image))
    return names


def _published_by_the_release() -> set[str]:
    """Every image reference the release workflow pushes, without its tag."""
    workflow = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    pushed = set()
    for job in workflow["jobs"].values():
        for step in job.get("steps") or []:
            options = step.get("with") or {}
            if not options.get("push"):
                continue
            for tag in str(options.get("tags", "")).splitlines():
                tag = tag.strip()
                if tag:
                    pushed.add(re.sub(r":\$?\{?[^/]*$", "", tag))
    return pushed


def _normalised(names: set[str]) -> set[str]:
    """Compare by the component path, since the topology hardcodes the repository and the workflow
    interpolates `${{ github.repository }}`."""
    return {name.rsplit("/", 1)[-1] for name in names}


def test_the_topology_names_at_least_the_three_components() -> None:
    """Precondition: without this the comparison below could pass on an empty set — the failure
    shape this project has now met five times."""
    named = _normalised(_named_by_the_topology())
    assert {"app", "console", "db"} <= named, (
        f"the install-by-version topology names {sorted(named)}; it must name all three components"
    )


def test_every_image_the_topology_names_is_published() -> None:
    """The regression. `denied` on a clean host is what this prevents."""
    named = _normalised(_named_by_the_topology())
    published = _normalised(_published_by_the_release())
    missing = named - published
    assert not missing, (
        f"the topology tells an operator to install {sorted(missing)}, and the release never "
        "publishes them — installing by version fails with `denied` on a clean host"
    )


def test_the_release_publishes_nothing_the_topology_cannot_use() -> None:
    """The other direction: an artifact nobody installs is cost with no reader.

    Weaker than the test above and deliberately so — it is a smell, not a break — but a published
    image that no topology names is usually a rename that only went halfway.
    """
    named = _normalised(_named_by_the_topology())
    published = _normalised(_published_by_the_release())
    orphans = published - named
    assert not orphans, (
        f"the release publishes {sorted(orphans)}, which no shipped topology installs"
    )


def test_a_release_candidate_is_published_as_a_prerelease() -> None:
    """The first real publication landed `v0.13.1-rc1` as a FULL release.

    `gh release create` does not infer the flag from the tag name, and a release candidate
    presented as final is precisely what an operator receives when they ask for the latest version
    — which is the audience this whole spec exists to serve.
    """
    workflow = WORKFLOW.read_text(encoding="utf-8")
    assert "--prerelease" in workflow, (
        "a tag with a prerelease suffix is published as a final release, so a candidate is what an "
        "operator gets when they follow the current instructions"
    )
    for suffix in ("-rc", "-alpha", "-beta"):
        assert suffix in workflow, f"the prerelease detection does not recognise {suffix!r}"
