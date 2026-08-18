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

**The second layer.** Reachability alone would not have helped. The probe asked for `{"ok": true}`.
Measured on a live OpenAI-compatible route with `gpt-oss:20b`:

    the flat probe schema                  83%
    extractor step 1 (entities)             0%
    extractor step 2 (relations)            0%
    extractor step 3 (claims)              25%
    chunk survival (all three must pass)    0%

A green probe over a route that discards 100% of a corpus is worse than no probe: the operator ingests
27 documents, gets 27 `processed` and 0 claims, and only the per-document error says why. So the probe
now asks for the shape that discriminates — a list of objects with required string fields, which is
what every extraction schema in this product is.
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


def test_the_probe_asks_for_a_shape_that_can_actually_fail() -> None:
    """A boolean probe passes on routes where every real schema fails, so it certifies nothing.

    Asserted on the parsed schema rather than the source text: a comment mentioning `ok: bool` would
    satisfy a grep, and this project has been fooled by its own prose four times.
    """
    from rsc_brain.gateway.model_gateway import _HealthProbe

    schema = _HealthProbe.model_json_schema()
    top = schema.get("properties", {})
    assert top, "the probe schema has no properties"
    arrays = [
        name
        for name, spec in top.items()
        if spec.get("type") == "array" or "$ref" in str(spec.get("items", ""))
    ]
    assert arrays, (
        f"the probe schema is flat ({sorted(top)}); a flat schema succeeded 83% on a route where the "
        "extractor's list-of-objects schemas succeeded 0%, so a pass would certify nothing"
    )
    nested = schema.get("$defs") or schema.get("definitions")
    assert nested, (
        "the probe's array holds scalars; what fails on real routes is a list of OBJECTS with "
        "required string fields, which is what every extraction schema in this product is"
    )


def test_probe_models_stays_off_by_default() -> None:
    """AUDIT-044 must not be undone by this fix: the container healthcheck runs `run_verify` on a
    timer, and probing there restarted healthy containers during a provider outage."""
    source = VERIFY.read_text(encoding="utf-8")
    assert "probe_models: bool = False" in source, (
        "probing must stay opt-in; on by default it returns to restarting healthy containers "
        "whenever a provider has an outage, and paying tokens on every healthcheck tick"
    )
