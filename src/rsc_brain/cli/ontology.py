"""`brain ontology` CLI (SPEC-24, FR-17.1/17.7): add · list · validate · coverage. Admin parity."""

from __future__ import annotations

from pathlib import Path

import typer

from rsc_brain.cli._common import JSON_OPTION, emit_result
from rsc_brain.cli.ingest import _cli_scope, _dispatch, _resolve_project_id
from rsc_brain.ontology.index import OntologyIndex, OntologyParseError
from rsc_brain.ontology.store import OntologyStore
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker

ontology_app = typer.Typer(
    help="Manage a project's optional ontology anchoring (OWL/RDF/SKOS).", no_args_is_help=True
)

_FORMAT_BY_SUFFIX = {
    ".ttl": "turtle",
    ".turtle": "turtle",
    ".owl": "owl",
    ".rdf": "rdf",
    ".xml": "rdf",
    ".skos": "skos",
}


def _infer_format(path: Path, override: str | None) -> str:
    if override:
        return override
    return _FORMAT_BY_SUFFIX.get(path.suffix.lower(), "turtle")


@ontology_app.command("add")
def ontology_add(
    ctx: typer.Context,
    file: Path = typer.Argument(..., help="OWL/RDF/SKOS file to load."),
    project: str = typer.Option(..., "--project", help="Project slug."),
    name: str | None = typer.Option(None, "--name", help="Ontology name (defaults to filename)."),
    fmt: str | None = typer.Option(
        None, "--format", help="owl|rdf|skos|turtle (inferred if omitted)."
    ),
    uri_base: str | None = typer.Option(
        None, "--uri-base", help="Base IRI for minted local nodes."
    ),
    json_output: bool = JSON_OPTION,
) -> None:
    """Validate and store a versioned ontology; a new upload of the same name becomes active."""
    if not file.exists():
        typer.echo(f"ontology add: file not found: {file}", err=True)
        raise typer.Exit(code=2)
    content = file.read_text(encoding="utf-8")
    resolved_format = _infer_format(file, fmt)
    ontology_name = name or file.stem

    async def _run() -> str | None:
        engine = make_engine()
        try:
            sessionmaker = make_sessionmaker(engine)
            project_id = await _resolve_project_id(sessionmaker, project)
            store = OntologyStore(sessionmaker)
            return await store.add(
                _cli_scope(project_id),
                name=ontology_name,
                content=content,
                fmt=resolved_format,
                uri_base=uri_base,
            )
        finally:
            await engine.dispose()

    try:
        ontology_id = _dispatch(_run())
    except OntologyParseError as exc:
        typer.echo(f"ontology add: invalid {resolved_format} file: {exc}", err=True)
        raise typer.Exit(code=2) from exc
    emit_result(
        ctx,
        json_output,
        {"status": "ok", "action": "add", "id": ontology_id, "name": ontology_name},
        f"brain ontology add: stored {ontology_name} ({ontology_id}).",
    )


@ontology_app.command("list")
def ontology_list(
    ctx: typer.Context,
    project: str = typer.Option(..., "--project", help="Project slug."),
    json_output: bool = JSON_OPTION,
) -> None:
    """List a project's ontologies (name, version, active, triple count)."""

    async def _run() -> list[dict[str, object]]:
        engine = make_engine()
        try:
            sessionmaker = make_sessionmaker(engine)
            project_id = await _resolve_project_id(sessionmaker, project)
            rows = await OntologyStore(sessionmaker).list_all(_cli_scope(project_id))
            return [
                {
                    "id": r.id,
                    "name": r.name,
                    "format": r.format,
                    "version": r.version,
                    "active": r.active,
                    "triples": r.triples,
                }
                for r in rows
            ]
        finally:
            await engine.dispose()

    rows = _dispatch(_run())
    human = "\n".join(
        f"{r['name']} v{r['version']} [{'active' if r['active'] else 'inactive'}] "
        f"{r['triples']} triples ({r['id']})"
        for r in rows
    )
    emit_result(ctx, json_output, {"ontologies": rows}, human or "no ontologies")


@ontology_app.command("validate")
def ontology_validate(
    ctx: typer.Context,
    file: Path = typer.Argument(..., help="OWL/RDF/SKOS file to check."),
    fmt: str | None = typer.Option(
        None, "--format", help="owl|rdf|skos|turtle (inferred if omitted)."
    ),
    json_output: bool = JSON_OPTION,
) -> None:
    """Parse a file and report whether it is valid RDF (no project needed; read-only)."""
    if not file.exists():
        typer.echo(f"ontology validate: file not found: {file}", err=True)
        raise typer.Exit(code=2)
    resolved_format = _infer_format(file, fmt)
    try:
        index = OntologyIndex.parse(file.read_text(encoding="utf-8"), resolved_format)
    except OntologyParseError as exc:
        emit_result(
            ctx,
            json_output,
            {"status": "invalid", "format": resolved_format, "error": str(exc)},
            f"brain ontology validate: INVALID — {exc}",
        )
        raise typer.Exit(code=1) from exc
    emit_result(
        ctx,
        json_output,
        {"status": "valid", "format": resolved_format, "triples": index.triples},
        f"brain ontology validate: valid {resolved_format}, {index.triples} triples.",
    )


@ontology_app.command("coverage")
def ontology_coverage(
    ctx: typer.Context,
    project: str = typer.Option(..., "--project", help="Project slug."),
    top: int = typer.Option(10, "--top", help="How many top unanchored names to list."),
    json_output: bool = JSON_OPTION,
) -> None:
    """Report anchoring coverage: % of entities anchored + the top unanchored names (FR-17.7)."""

    async def _run() -> dict[str, object]:
        engine = make_engine()
        try:
            sessionmaker = make_sessionmaker(engine)
            project_id = await _resolve_project_id(sessionmaker, project)
            return await OntologyStore(sessionmaker).coverage(_cli_scope(project_id), top_n=top)
        finally:
            await engine.dispose()

    data = _dispatch(_run())
    coverage_value = data["coverage"]
    pct = float(coverage_value) * 100 if isinstance(coverage_value, int | float) else 0.0
    human = f"brain ontology coverage: {data['anchored']}/{data['total']} anchored ({pct:.1f}%)"
    emit_result(ctx, json_output, data, human)
