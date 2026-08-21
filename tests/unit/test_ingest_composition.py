"""Every production ingestion path must carry the same collaborators (AUDIT-112 / R53).

R53 was raised because the API and the worker assembled different dependency graphs. It was closed
by giving both roles :func:`rsc_brain.runtime.build` — but the *pipeline* was left to each caller,
and `runtime.build_pipeline`, the one place that wires contradiction detection for every role, ended
up with no caller at all. The worker therefore processed every queued document with
`contradiction_resolver=None`, and `_detect_contradictions_on_ingest` no-ops on None: gate G3's
mechanism was unreachable in the shipped topology, where accepting a document enqueues it.

These tests read the composition, not the behaviour, because that is where the omission lives.
"""

from __future__ import annotations

import ast
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "src" / "rsc_brain"
#: Where a pipeline may be constructed: the composition root, and the API's inline path which
#: predates it. Every other entry point must route through the root.
ALLOWED_CONSTRUCTION_SITES = {"runtime.py", "app.py"}


def _pipeline_constructions(path: Path) -> list[ast.Call]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    return [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "IngestionPipeline"
    ]


def test_the_composition_root_has_a_caller() -> None:
    """A factory nobody calls is a wiring that does not exist (AUDIT-096's shape)."""
    callers = [
        path
        for path in SRC.rglob("*.py")
        if path.name != "runtime.py" and "build_pipeline" in path.read_text(encoding="utf-8")
    ]

    assert callers, (
        "runtime.build_pipeline has no caller, so the contradiction resolver it wires reaches no "
        "process. Its own docstring claims neither entry point can forget it."
    )


def test_no_entry_point_builds_its_own_pipeline() -> None:
    offenders = {
        path.relative_to(REPO).as_posix()
        for path in SRC.rglob("*.py")
        if path.name not in ALLOWED_CONSTRUCTION_SITES and _pipeline_constructions(path)
    }

    assert not offenders, (
        "these entry points assemble their own ingestion pipeline instead of using "
        f"runtime.build_pipeline, so a collaborator added there never reaches them: {offenders}"
    )


def test_every_pipeline_construction_wires_contradiction_detection() -> None:
    """The resolver is the collaborator G3 depends on; an omitted kwarg silently disables it."""
    missing: list[str] = []
    for path in SRC.rglob("*.py"):
        for call in _pipeline_constructions(path):
            keywords = {keyword.arg for keyword in call.keywords}
            if "contradiction_resolver" not in keywords:
                missing.append(f"{path.relative_to(REPO).as_posix()}:{call.lineno}")

    assert not missing, (
        "these pipelines are built without a contradiction resolver, and "
        f"_detect_contradictions_on_ingest no-ops when it is None: {missing}"
    )


def test_the_root_actually_wires_a_resolver(tmp_path: Path) -> None:
    """The AST checks above prove the call sites; this proves what the root hands them."""
    from rsc_brain import runtime
    from rsc_brain.config.models import CapabilitiesConfig, CapabilityConfig, ModelEgressConfig
    from rsc_brain.gateway.model_gateway import ModelGateway
    from rsc_brain.ingest.pipeline import PipelineConfig

    route = CapabilityConfig(
        provider="ollama",
        model="test-model",
        api_base="http://127.0.0.1:11434",
        egress=ModelEgressConfig(allow_http=True, allow_private_network=True),
    )
    dependencies = runtime.RuntimeDependencies(
        role="worker",
        engine=None,  # type: ignore[arg-type]
        sessionmaker=None,  # type: ignore[arg-type]
        gateway=ModelGateway(
            CapabilitiesConfig(extractor=route, judge=route, topicalizer=route, embedder=route)
        ),
        pipeline_config=PipelineConfig(),
        recall_config=None,  # type: ignore[arg-type]
        limits=None,  # type: ignore[arg-type]
        ingress=None,  # type: ignore[arg-type]
        hunting=None,  # type: ignore[arg-type]
        maintenance=None,  # type: ignore[arg-type]
        reranker_enabled=False,
        data_dir=str(tmp_path),
    )

    pipeline = runtime.build_pipeline(dependencies)

    assert pipeline._resolver is not None, (
        "the composition root itself omits contradiction detection, so no caller can inherit it"
    )
