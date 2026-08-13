"""The shipped production defaults must be installable as they ship (AUDIT-058/059/060/061).

Found on a rented host: the default embedder returns 768 dimensions while the gateway anchors at
1024 and refuses anything else, so the published production configuration could not start. The
other three are the friction an operator hits before reaching that point.
"""

from __future__ import annotations

from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[2]
COMPOSE = REPO / "deploy" / "docker-compose.prod.yml"
LAYERS = ("EXTRACTOR", "JUDGE", "TOPICALIZER", "EMBEDDER", "RERANKER")


def _rendered() -> str:
    return COMPOSE.read_text(encoding="utf-8")


def test_the_default_embedder_matches_the_anchored_dimension() -> None:
    """AUDIT-058: `nomic-embed-text` returns 768 dims — measured, not assumed. The gateway anchors
    at 1024 and fails loudly, so the shipped default cannot start."""
    from rsc_brain.config.models import ANCHORED_EMBEDDING_DIM

    assert ANCHORED_EMBEDDING_DIM == 1024
    # Look at the default VALUE, not at any mention: the comment recording why the old default was
    # wrong is worth keeping, and a test that forbids naming a mistake forbids documenting it.
    text = _rendered()
    default = next(
        line.split(":-", 1)[1].rstrip("}").strip()
        for line in text.splitlines()
        if "RSC_BRAIN_CAPABILITIES__EMBEDDER__MODEL:" in line
    )
    assert default != "nomic-embed-text", (
        "the default embedder returns 768 dimensions and the gateway anchors at 1024: a fresh "
        "`docker compose up` cannot start with it"
    )
    assert default == "bge-m3", f"the default embedder must be 1024-dimensional, got {default!r}"


def test_every_capability_layer_has_a_default_so_no_overlay_is_hand_written() -> None:
    """AUDIT-059: the compose exposed only the embedder's three variables, so an operator had to
    hand-author twenty environment entries across two services before anything would start — and
    the README told them to. Configuration an operator must invent is configuration the product
    failed to ship."""
    text = _rendered()
    for layer in LAYERS:
        for field in ("PROVIDER", "MODEL"):
            key = f"RSC_BRAIN_CAPABILITIES__{layer}__{field}"
            assert key in text, f"{key} has no default in the production compose"


def test_the_public_origin_is_derived_from_the_domain_the_operator_sets() -> None:
    """AUDIT-060: `init-secrets.sh` wrote a placeholder domain but never the public origin, which
    governs OAuth metadata, the request-to-a-human links, and the transport's Host/Origin
    boundary. Two values that must agree, one of them left for the operator to remember."""
    script = (REPO / "deploy" / "init-secrets.sh").read_text(encoding="utf-8")
    assert "RSC_BRAIN_INGRESS__PUBLIC_ORIGIN" in script, (
        "the secrets bootstrap must write the public origin, not leave it to be remembered"
    )


def test_application_volumes_have_their_ownership_initialised() -> None:
    """AUDIT-061: the image runs as uid 10001 but the compose left fresh named volumes owned by
    root, so the documented install required a manual one-shot `chown` before anything started."""
    spec = yaml.safe_load(_rendered())
    services = spec["services"]
    assert "init-volumes" in services, (
        "no service initialises app_data/inbox ownership, so the operator must run a manual chown"
    )
    init = services["init-volumes"]
    assert str(init.get("user")) in {"0", "0:0", "root"}, "the initialiser must run as root"
    for dependant in ("api", "worker", "migrate"):
        depends = services[dependant].get("depends_on") or {}
        names = depends if isinstance(depends, list) else list(depends)
        assert "init-volumes" in names, f"{dependant} must wait for volume ownership"
