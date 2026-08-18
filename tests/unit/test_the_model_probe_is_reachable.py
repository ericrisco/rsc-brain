"""AUDIT-099: FR-9.3's model probe was unreachable in an installed product.

`ModelGateway.healthcheck` implements FR-9.3 — "Run a real structured/embed probe per configured
capability". AUDIT-044 correctly moved it off the container healthcheck (probing on a timer restarted
healthy containers during a provider outage and paid tokens forever), and `run_verify` grew a
`probe_models` parameter. Its docstring named the way to ask for it:

    it moved behind ``probe_models=True`` (``brain doctor`` and an explicit `--probe-models`)

Measured against the shipped image:

    brain verify --probe-models   ->  No such option: --probe-models
    brain doctor                  ->  profile, docker, gpu, ram, secrets, domain. No capability.

`probe_models=True` was passed by exactly one caller in the repository: an integration test. So the
whole of FR-9.3 was dead code in an installed product, and the docstring pointed at two ways to reach
it, neither of which existed.

This is AUDIT-096's shape a second time on the same day — a component whose test proves it works while
nothing proves it is reachable. There the recorder was `degradation_of`; here it is an entire
requirement.

**The second layer.** Reachability alone would not have helped. The probe asked for `{"ok": true}`,
and on a live route with `gpt-oss:20b` that flat shape succeeded 83% while the extractor's three real
steps succeeded 0%, 0% and 25% — and any one failure discards the chunk, so chunk survival was 0%.

**The first fix for that was wrong, and this test records it.** I made the generic schema richer — a
list of objects with required string fields — on the theory that shape was the discriminator. The
richer probe passed on the very route that discarded every chunk. Crossing the halves:

    probe prompt + probe schema   3/3
    probe prompt + REAL schema    0/3
    REAL prompt  + probe schema   0/3
    REAL prompt  + REAL schema    0/3

Only the self-consistent cell passes, and it passes *because* a probe prompt spells out the exact JSON
it wants, so the model copies it. **A generic probe cannot predict whether a capability works** — it
measures the route's ability to obey an instruction that hands it the answer.

So `healthcheck` takes its probes from the caller and `installer.verify` supplies each capability's own
prompt and schema. On the failing route that now reports extractor FAILED, judge FAILED, topicalizer /
embedder / reranker ok — which matches every independent measurement, including that the reranker
genuinely does work there.
"""

from __future__ import annotations

import ast
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CLI = REPO / "src" / "rsc_brain" / "cli" / "installer.py"
VERIFY = REPO / "src" / "rsc_brain" / "installer" / "verify.py"
GATEWAY = REPO / "src" / "rsc_brain" / "gateway" / "model_gateway.py"


def test_the_cli_exposes_the_flag_its_own_docstring_promises() -> None:
    """The regression. `run_verify`'s docstring named `--probe-models`; the option did not exist."""
    source = CLI.read_text(encoding="utf-8")
    assert "--probe-models" in source, (
        "run_verify documents an explicit `--probe-models` and the CLI defines no such option, so "
        "FR-9.3 cannot be reached from an installed product"
    )


def test_the_cli_actually_forwards_it() -> None:
    """Declaring the option and not passing it through would satisfy the check above and change
    nothing — the failure mode this whole campaign keeps meeting."""
    tree = ast.parse(CLI.read_text(encoding="utf-8"))
    forwarded = False
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = (
            node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", "")
        )
        if name != "run_verify":
            continue
        forwarded = any(kw.arg == "probe_models" for kw in node.keywords)
    assert forwarded, "the CLI never passes probe_models to run_verify, so the flag is decoration"


def test_no_capability_probe_is_reachable_only_from_tests() -> None:
    """Closes the class. `healthcheck` is the single entry point to FR-9.3; if the only thing that
    reaches it is a test, the requirement is not delivered."""
    callers = []
    for path in (REPO / "src").rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "healthcheck"
            ):
                callers.append(path.relative_to(REPO))
    assert callers, (
        "nothing in src/ calls ModelGateway.healthcheck; FR-9.3 is implemented and unreachable"
    )


def test_each_capability_is_probed_with_its_own_prompt_and_schema() -> None:
    """The replacement for a wrong assumption.

    A generic probe passes on routes where every real call fails, measured. The only probe that
    discriminates is the capability's own prompt and schema, so the readiness layer must supply them.
    """
    from rsc_brain.config.models import Capability
    from rsc_brain.installer.verify import _real_probes

    probes = _real_probes()
    for capability in (Capability.EXTRACTOR, Capability.JUDGE, Capability.TOPICALIZER):
        assert capability in probes, f"{capability.value} is probed with a generic schema"
    # The reranker especially: when its route cannot serve structured output, abstention silently
    # reverts to the blended threshold (AUDIT-085, AUDIT-096) and nothing else surfaces it.
    assert Capability.RERANKER in probes, "the reranker's route is the least observable of the five"

    for capability, (messages, schema) in probes.items():
        assert messages and messages[0].get("content"), f"{capability.value} probe has no prompt"
        # A probe prompt that spells out the exact JSON it wants is answered by copying, which is why
        # the generic one certified nothing. The real prompts do not do that.
        assert "Reply as JSON" not in str(messages), (
            f"{capability.value} is probed with a self-answering prompt, which passes on routes that "
            "fail every real call"
        )
        assert schema.model_json_schema().get("properties"), (
            f"{capability.value} probe schema has no fields"
        )


def test_probe_models_stays_off_by_default() -> None:
    """AUDIT-044 must not be undone by this fix: the container healthcheck runs `run_verify` on a
    timer, and probing there restarted healthy containers during a provider outage."""
    source = VERIFY.read_text(encoding="utf-8")
    assert "probe_models: bool = False" in source, (
        "probing must stay opt-in; on by default it returns to restarting healthy containers "
        "whenever a provider has an outage, and paying tokens on every healthcheck tick"
    )
