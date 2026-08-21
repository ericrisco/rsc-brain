"""Prepare, execute and combine the exact AUDIT-011 graph decision benchmark."""

from __future__ import annotations

import argparse
import asyncio
import os
import platform
import uuid
from pathlib import Path

from pydantic import BaseModel

from evals.graph_benchmark import (
    DECISION_EDGES,
    DECISION_NODES,
    DECISION_SEED,
    BenchmarkEnvironment,
    BenchmarkProfile,
    DecisionRun,
    GraphCounts,
    GraphWorkload,
    combine_decision_runs,
    decision_workload,
    load_workload_files,
    measure_khop_run,
    write_workload_files,
)
from evals.graph_benchmark_age import AgeCsvBenchmarkLoader
from rsc_brain.scope import Principal, PrincipalType
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker

_BENCHMARK_PRINCIPAL = "11111111-1111-1111-1111-111111111111"
_BENCHMARK_PROJECT = "22222222-2222-2222-2222-222222222222"


def _host_memory_bytes() -> int:
    try:
        return int(os.sysconf("SC_PAGE_SIZE")) * int(os.sysconf("SC_PHYS_PAGES"))
    except (AttributeError, OSError, ValueError):
        raise RuntimeError("host memory is unavailable; pass --host-memory-bytes") from None


def _write_model(path: Path, value: BaseModel) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value.model_dump_json(indent=2) + "\n", encoding="utf-8")


async def _run_age_profile(args: argparse.Namespace) -> DecisionRun:
    prepared = load_workload_files(args.manifest)
    profile = BenchmarkProfile(args.profile)
    project_id = str(uuid.UUID(args.project_id))
    scope = Principal(
        id=_BENCHMARK_PRINCIPAL,
        type=PrincipalType.HUMAN,
    ).scope_for(project_id)
    engine = make_engine()
    try:
        loader = AgeCsvBenchmarkLoader(
            make_sessionmaker(engine),
            server_csv_root=args.server_csv_root,
        )
        load = await loader.reset_load_count(scope, prepared)
        environment = BenchmarkEnvironment(
            profile=profile,
            backend=load.backend,
            backend_version=load.backend_version,
            postgres_version=load.postgres_version,
            image_identity=args.image_identity,
            host_os=platform.platform(),
            host_arch=platform.machine(),
            host_cpu=args.host_cpu or platform.processor() or platform.machine(),
            host_cpu_count=args.host_cpu_count or os.cpu_count() or 1,
            host_memory_bytes=args.host_memory_bytes or _host_memory_bytes(),
            container_cpu_limit=args.container_cpu_limit,
            container_memory_bytes=args.container_memory_bytes,
            accelerator=args.accelerator,
        )
        manifest = prepared.manifest
        workload = GraphWorkload(
            n_nodes=manifest.counts.nodes,
            n_edges=manifest.counts.edges,
            seed=manifest.seed,
            relation_labels=manifest.relation_labels,
        )
        decision_run = (
            manifest.counts == GraphCounts(nodes=DECISION_NODES, edges=DECISION_EDGES)
            and workload == decision_workload(seed=manifest.seed)
            and manifest.seed == DECISION_SEED
        )
        run = await measure_khop_run(
            loader.graph_store,
            scope,
            workload=workload,
            persisted_counts=load.persisted_counts,
            workload_sha256=manifest.workload_sha256,
            load_seconds=load.load_seconds,
            environment=environment,
            decision_run=decision_run,
        )
    finally:
        await engine.dispose()
    _write_model(args.output, run)
    return run


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare = subparsers.add_parser("prepare", help="stream the exact 200k/1M CSV workload")
    prepare.add_argument("--output-dir", type=Path, required=True)

    run = subparsers.add_parser("run-age", help="load, count and measure one AGE profile")
    run.add_argument("--manifest", type=Path, required=True)
    run.add_argument("--profile", choices=[item.value for item in BenchmarkProfile], required=True)
    run.add_argument("--server-csv-root", required=True)
    run.add_argument("--output", type=Path, required=True)
    run.add_argument("--image-identity", required=True)
    run.add_argument("--container-cpu-limit", type=float, required=True)
    run.add_argument("--container-memory-bytes", type=int, required=True)
    run.add_argument("--accelerator", required=True)
    run.add_argument("--host-cpu")
    run.add_argument("--host-cpu-count", type=int)
    run.add_argument("--host-memory-bytes", type=int)
    run.add_argument("--project-id", default=_BENCHMARK_PROJECT)

    combine = subparsers.add_parser("combine", help="validate both candidates and emit the verdict")
    combine.add_argument("--workstation", type=Path, required=True)
    combine.add_argument("--cpu-only", type=Path, required=True)
    combine.add_argument("--output", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "prepare":
        prepared = write_workload_files(args.output_dir, decision_workload())
        print(prepared.root / "workload-manifest.json")
        return 0
    if args.command == "run-age":
        run = asyncio.run(_run_age_profile(args))
        print(f"{run.environment.profile.value}: p95={run.p95_ms:.3f}ms -> {args.output}")
        return 0
    if args.command == "combine":
        workstation = DecisionRun.model_validate_json(args.workstation.read_text(encoding="utf-8"))
        cpu_only = DecisionRun.model_validate_json(args.cpu_only.read_text(encoding="utf-8"))
        artifact = combine_decision_runs((workstation, cpu_only))
        _write_model(args.output, artifact)
        print(f"verdict={artifact.verdict} -> {args.output}")
        return 0
    raise AssertionError("argparse accepted an unknown command")


if __name__ == "__main__":
    raise SystemExit(main())
