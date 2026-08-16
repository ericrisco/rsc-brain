#!/usr/bin/env python3
"""Validate the public documentation contract for rsc-brain."""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import get_args
from urllib.parse import unquote, urlsplit

from pydantic import BaseModel
from typer.main import get_command

_LINK_RE = re.compile(r"!?\[[^\]]*\]\((?P<target><[^>]+>|[^\s)]+)(?:\s+[\"'][^)]*[\"'])?\)")
_EXTERNAL_SCHEMES = frozenset({"data", "http", "https", "mailto", "tel"})
_HTTP_METHODS = frozenset({"delete", "get", "head", "options", "patch", "post", "put", "trace"})
_INLINE_CODE_RE = re.compile(r"(?<!`)`([^`\n]+)`(?!`)")
_BANNED_TERMS = (
    "in order to",
    "blazing-fast",
    "blazing fast",
    "effortlessly",
    "effortless",
    "seamlessly",
    "seamless",
    "supercharge",
    "simply",
    "easily",
    "leverage",
    "utilize",
    "just",
)
_PRIVATE_PATHS = ("02-DOCS/", "01-TOOLS/", ".rsc/")
_STALE_MARKERS = (
    ("Sprint 0", re.compile(r"\bsprint\s*0\b", re.IGNORECASE)),
    ("future SPEC", re.compile(r"\bfuture\s+spec\b", re.IGNORECASE)),
    ("later SPEC", re.compile(r"\blater\s+specs?\b", re.IGNORECASE)),
    ("bootstrap-only", re.compile(r"\bbootstrap[- ]only\b", re.IGNORECASE)),
    (
        "not implemented in this SPEC",
        re.compile(r"\bnot\s+implemented\s+in\s+this\s+spec\b", re.IGNORECASE),
    ),
    (
        "future implementation claim",
        re.compile(r"\b(?:lands?|arrives?)\s+in\s+spec[- ]?\d+\b", re.IGNORECASE),
    ),
)
_PUBLIC_ROOT_FILES = ("README.md", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md")
_PUBLIC_DIRECTORIES = ("apps/admin", "deploy", "docker", "docs", "evals")
_GENERATED_DIRECTORY_NAMES = frozenset(
    {"node_modules", ".venv", ".next", "__pycache__", ".dart_tool", "build"}
)
_REQUIRED_PAGES: dict[str, tuple[str, ...]] = {
    "narrative": (
        "README.md",
        "docs/index.md",
        "docs/tutorials/getting-started.md",
        "docs/explanation/architecture.md",
        "docs/explanation/knowledge-lifecycle.md",
        "docs/explanation/security-and-tenancy.md",
    ),
    "reference": (
        "docs/reference/cli.md",
        "docs/reference/configuration.md",
        "docs/reference/mcp.md",
        "docs/reference/permissions.md",
        "docs/reference/rest-api.md",
    ),
    "operator": (
        "docs/how-to/backup-and-restore.md",
        "docs/how-to/connect-mcp-client.md",
        "docs/how-to/ingest-and-query.md",
        "docs/how-to/troubleshooting.md",
        "docs/how-to/upgrade.md",
    ),
}
_REFERENCE_HEADINGS: dict[str, tuple[str, ...]] = {
    "docs/reference/cli.md": ("global-options", "exit-codes", "unsupported-commands"),
    "docs/reference/configuration.md": ("precedence", "secret-handling", "validation"),
    "docs/reference/mcp.md": (
        "authentication",
        "authorization",
        "errors",
        "quotas-and-limits",
        "trust-and-provenance",
    ),
    "docs/reference/permissions.md": (
        "principal-and-credential-types",
        "capability-matrix",
        "topic-scope",
        "denial-behaviour",
    ),
    "docs/reference/rest-api.md": (
        "authentication",
        "authorization",
        "errors",
        "quotas-and-limits",
        "trust-and-provenance",
    ),
}


@dataclass(frozen=True, slots=True)
class Finding:
    """One actionable documentation-contract violation."""

    rule: str
    path: Path
    line: int
    message: str

    def __str__(self) -> str:
        return f"{self.path}:{self.line}: [{self.rule}] {self.message}"


def check_local_links(repository: Path, paths: Iterable[Path]) -> list[Finding]:
    """Return findings for local Markdown links that do not resolve."""
    repository = repository.resolve()
    findings: list[Finding] = []
    for source in sorted((path.resolve() for path in paths), key=str):
        for line_number, target in _markdown_links(source):
            resolved = _resolve_local_target(repository, source, target)
            if resolved is None:
                continue
            target_path, fragment = resolved
            if not _is_within(target_path, repository) or not target_path.exists():
                findings.append(
                    Finding(
                        rule="link",
                        path=_relative_to(repository, source),
                        line=line_number,
                        message=f"local target does not exist: {target}",
                    )
                )
                continue
            if fragment and target_path.suffix.lower() == ".md":
                anchors = _markdown_anchors(target_path)
                if fragment.lower() not in anchors:
                    findings.append(
                        Finding(
                            rule="link",
                            path=_relative_to(repository, source),
                            line=line_number,
                            message=f"heading anchor does not exist: {target}",
                        )
                    )
    return findings


def check_navigation(
    repository: Path,
    pages: Iterable[Path],
    roots: Iterable[Path],
) -> list[Finding]:
    """Return findings for public pages unreachable from a navigation root."""
    repository = repository.resolve()
    resolved_pages = {path.resolve() for path in pages}
    reachable = {path.resolve() for path in roots if path.resolve() in resolved_pages}
    pending = list(reachable)

    while pending:
        source = pending.pop()
        for _, target in _markdown_links(source):
            resolved = _resolve_local_target(repository, source, target)
            if resolved is None:
                continue
            target_path, _ = resolved
            if target_path in resolved_pages and target_path not in reachable:
                reachable.add(target_path)
                pending.append(target_path)

    return [
        Finding(
            rule="navigation",
            path=_relative_to(repository, path),
            line=1,
            message="public page is not reachable from README.md or docs/index.md",
        )
        for path in sorted(resolved_pages - reachable, key=str)
    ]


def check_banned_terms(paths: Iterable[Path]) -> list[Finding]:
    """Return findings for the exact filler terms banned by the docs contract."""
    patterns = [
        (term, re.compile(rf"(?<![\w-]){re.escape(term)}(?![\w-])", re.IGNORECASE))
        for term in _BANNED_TERMS
    ]
    return _scan_lines(paths, "banned-term", patterns, "banned filler term")


def check_private_paths(paths: Iterable[Path]) -> list[Finding]:
    """Return findings for dependencies on private workspace paths."""
    patterns = [(prefix, re.compile(re.escape(prefix), re.IGNORECASE)) for prefix in _PRIVATE_PATHS]
    return _scan_lines(paths, "private-path", patterns, "private workspace dependency")


def check_stale_markers(paths: Iterable[Path]) -> list[Finding]:
    """Return findings for known obsolete current-state claims."""
    current_paths = [path for path in paths if path.name.casefold() != "changelog.md"]
    return _scan_lines(
        current_paths,
        "stale-marker",
        list(_STALE_MARKERS),
        "obsolete current-state marker",
    )


def collect_public_pages(repository: Path, scope: str = "all") -> list[Path]:
    """Return reader-facing Markdown pages for a validation scope."""
    repository = repository.resolve()
    all_pages: set[Path] = {
        repository / relative
        for relative in _PUBLIC_ROOT_FILES
        if (repository / relative).is_file()
    }
    for relative in _PUBLIC_DIRECTORIES:
        directory = repository / relative
        if directory.is_dir():
            all_pages.update(
                path
                for path in directory.rglob("*.md")
                if not _GENERATED_DIRECTORY_NAMES.intersection(path.relative_to(repository).parts)
            )

    if scope == "all":
        return sorted(all_pages, key=str)

    scoped: set[Path] = {
        path
        for path in (repository / "README.md", repository / "docs" / "index.md")
        if path.is_file()
    }
    if scope == "narrative":
        scoped.update(
            path
            for path in all_pages
            if _relative_to(repository, path)
            .as_posix()
            .startswith(("docs/tutorials/", "docs/explanation/"))
        )
    elif scope == "reference":
        scoped.update(
            path
            for path in all_pages
            if _relative_to(repository, path).as_posix().startswith("docs/reference/")
        )
    else:
        raise ValueError(f"unknown documentation scope: {scope}")
    return sorted(scoped, key=str)


def check_repository(repository: Path, scope: str = "all") -> list[Finding]:
    """Run the deterministic public documentation contract."""
    repository = repository.resolve()
    pages = collect_public_pages(repository, scope)
    roots = [repository / "README.md", repository / "docs" / "index.md"]
    findings = [
        *check_required_pages(repository, scope),
        *check_local_links(repository, pages),
        *check_navigation(repository, pages, roots),
        *check_banned_terms(pages),
        *check_private_paths(pages),
        *check_stale_markers(pages),
        *check_diataxis_modes(repository, pages),
    ]
    if scope in {"all", "reference"}:
        findings.extend(check_reference_contract(repository))
    return sorted(findings, key=lambda finding: (str(finding.path), finding.line, finding.rule))


def check_required_pages(repository: Path, scope: str) -> list[Finding]:
    """Return findings for canonical documentation units that are absent."""
    groups = ("narrative", "reference", "operator") if scope == "all" else (scope,)
    return [
        Finding(
            rule="required-page",
            path=Path(relative),
            line=1,
            message="canonical public documentation page is missing",
        )
        for group in groups
        for relative in _REQUIRED_PAGES[group]
        if not (repository / relative).is_file()
    ]


def check_diataxis_modes(repository: Path, pages: Iterable[Path]) -> list[Finding]:
    """Require explicit, path-consistent mode metadata on canonical mode pages."""
    findings: list[Finding] = []
    mode_roots = {
        "docs/tutorials/": "tutorial",
        "docs/how-to/": "how-to",
        "docs/reference/": "reference",
        "docs/explanation/": "explanation",
    }
    for path in pages:
        relative = _relative_to(repository, path).as_posix()
        expected = next(
            (mode for prefix, mode in mode_roots.items() if relative.startswith(prefix)), None
        )
        if expected is None:
            continue
        marker = f"<!-- diataxis: {expected} -->"
        if marker not in "\n".join(path.read_text(encoding="utf-8").splitlines()[:12]):
            findings.append(
                Finding(
                    rule="diataxis-mode",
                    path=Path(relative),
                    line=1,
                    message=f"expected `{marker}` near the top of the page",
                )
            )
    return findings


def check_reference_contract(repository: Path) -> list[Finding]:
    """Check exhaustive interface lookup coverage and required semantics."""
    findings: list[Finding] = []
    coverage_specs = (
        ("openapi-coverage", "docs/reference/rest-api.md", collect_openapi),
        ("cli-coverage", "docs/reference/cli.md", collect_cli),
        ("mcp-coverage", "docs/reference/mcp.md", collect_mcp),
        ("config-coverage", "docs/reference/configuration.md", collect_config),
    )
    for rule, relative, collector in coverage_specs:
        path = repository / relative
        if not path.is_file():
            continue
        documented = collect_documented_tokens([path])
        inventory = collector(repository)
        if not inventory:
            # A coverage rule compares an inventory against the docs. An EMPTY inventory subtracts
            # to nothing, so the rule reports "fully documented" having checked no interface at
            # all — the gate passes precisely when its collector is broken. This product always
            # ships CLI commands, MCP tools, config fields and REST operations, so an empty
            # inventory is never a true observation; it is the collector failing.
            findings.append(
                Finding(
                    rule=rule,
                    path=Path(relative),
                    line=1,
                    message=(
                        f"{collector.__name__} returned an empty inventory, so this coverage rule "
                        "would pass without checking anything — treat as a broken collector"
                    ),
                )
            )
            continue
        for interface in sorted(missing_coverage(inventory, documented)):
            findings.append(
                Finding(
                    rule=rule,
                    path=Path(relative),
                    line=1,
                    message=f"interface has no exact visible lookup token: {interface}",
                )
            )

    for relative, required_anchors in _REFERENCE_HEADINGS.items():
        path = repository / relative
        if not path.is_file():
            continue
        anchors = _markdown_anchors(path)
        for anchor in required_anchors:
            if anchor not in anchors:
                findings.append(
                    Finding(
                        rule="reference-semantics",
                        path=Path(relative),
                        line=1,
                        message=f"required reference section is missing: #{anchor}",
                    )
                )
    return findings


def collect_openapi(repository: Path) -> set[str]:
    """Return the current OpenAPI operation inventory."""
    path = repository / "apps" / "admin" / "openapi.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    raw_paths = payload.get("paths", {})
    if not isinstance(raw_paths, dict):
        raise ValueError(f"OpenAPI paths must be an object: {path}")

    operations: set[str] = set()
    for route, path_item in raw_paths.items():
        if not isinstance(route, str) or not isinstance(path_item, dict):
            raise ValueError(f"invalid OpenAPI path item in {path}: {route!r}")
        operations.update(
            f"{method.upper()} {route}"
            for method in path_item
            if isinstance(method, str) and method.casefold() in _HTTP_METHODS
        )
    return operations


def collect_cli(repository: Path) -> set[str]:
    """Return every registered CLI command path."""
    if not (repository / "src" / "rsc_brain" / "cli" / "main.py").is_file():
        raise FileNotFoundError("CLI registry not found under repository/src/rsc_brain/cli")

    from rsc_brain.cli.main import app

    root = get_command(app)
    commands: set[str] = set()
    _walk_click_commands(root, (), commands)
    return commands


def collect_mcp(repository: Path) -> set[str]:
    """Return every registered MCP tool name."""
    path = repository / "src" / "rsc_brain" / "mcp" / "server.py"
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    tools: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)):
            continue
        for decorator in node.decorator_list:
            if not _is_tool_decorator(decorator):
                continue
            tools.add(_decorated_tool_name(node.name, decorator))
    return tools


def collect_config(repository: Path) -> set[str]:
    """Return every supported dotted configuration field."""
    if not (repository / "src" / "rsc_brain" / "config" / "models.py").is_file():
        raise FileNotFoundError(
            "configuration model not found under repository/src/rsc_brain/config"
        )

    from rsc_brain.config.models import AppConfig

    return _collect_model_fields(AppConfig)


def collect_documented_tokens(paths: Iterable[Path]) -> set[str]:
    """Return visible inline-code tokens used as interface lookup keys."""
    tokens: set[str] = set()
    for path in paths:
        content = path.read_text(encoding="utf-8")
        tokens.update(match.group(1).strip() for match in _INLINE_CODE_RE.finditer(content))
    return {token for token in tokens if token}


def missing_coverage(inventory: Iterable[str], documented: Iterable[str]) -> set[str]:
    """Return interfaces that have no exact visible lookup token."""
    return set(inventory) - set(documented)


def _walk_click_commands(
    command: object,
    prefix: tuple[str, ...],
    inventory: set[str],
) -> None:
    """Walk a Typer/Click command tree, duck-typed on ``.commands``.

    This used to branch on ``isinstance(command, click.Group)``. Typer 0.27 vendors its own click,
    so the root became an instance of ``typer._click.core.Command`` and that test silently turned
    false — the walk stopped at the root and the CLI inventory came back **empty**, which
    ``missing_coverage`` reports as "nothing undocumented". A dependency bump could therefore turn
    this whole gate green over zero commands. Which class typer wraps is typer's business; whether
    a command holds subcommands is the question this walk actually asks.
    """
    children = getattr(command, "commands", None)
    if not isinstance(children, dict):
        return
    for name, child in sorted(children.items()):
        path = (*prefix, name)
        inventory.add("brain " + " ".join(path))
        _walk_click_commands(child, path, inventory)


def _is_tool_decorator(decorator: ast.expr) -> bool:
    target = decorator.func if isinstance(decorator, ast.Call) else decorator
    return isinstance(target, ast.Attribute) and target.attr == "tool"


def _decorated_tool_name(function_name: str, decorator: ast.expr) -> str:
    if not isinstance(decorator, ast.Call):
        return function_name
    for keyword in decorator.keywords:
        if (
            keyword.arg == "name"
            and isinstance(keyword.value, ast.Constant)
            and isinstance(keyword.value.value, str)
        ):
            return keyword.value.value
    if decorator.args and isinstance(decorator.args[0], ast.Constant):
        value = decorator.args[0].value
        if isinstance(value, str):
            return value
    return function_name


def _collect_model_fields(
    model: type[BaseModel],
    prefix: str = "",
    lineage: tuple[type[BaseModel], ...] = (),
) -> set[str]:
    fields: set[str] = set()
    for name, field in model.model_fields.items():
        public_name = field.alias or name
        dotted = f"{prefix}.{public_name}" if prefix else public_name
        fields.add(dotted)
        for nested_model in _nested_model_types(field.annotation):
            if nested_model in lineage:
                continue
            fields.update(_collect_model_fields(nested_model, dotted, (*lineage, model)))
    return fields


def _nested_model_types(annotation: object) -> set[type[BaseModel]]:
    nested: set[type[BaseModel]] = set()
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        nested.add(annotation)
    for argument in get_args(annotation):
        nested.update(_nested_model_types(argument))
    return nested


def _scan_lines(
    paths: Iterable[Path],
    rule: str,
    patterns: list[tuple[str, re.Pattern[str]]],
    description: str,
) -> list[Finding]:
    findings: list[Finding] = []
    for path in sorted(paths, key=str):
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            for label, pattern in patterns:
                if pattern.search(line):
                    findings.append(
                        Finding(
                            rule=rule,
                            path=_display_path(path),
                            line=line_number,
                            message=f"{description}: {label}",
                        )
                    )
                    break
    return findings


def _markdown_links(path: Path) -> list[tuple[int, str]]:
    links: list[tuple[int, str]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        for match in _LINK_RE.finditer(line):
            target = match.group("target").strip("<>")
            links.append((line_number, target))
    return links


def _resolve_local_target(repository: Path, source: Path, target: str) -> tuple[Path, str] | None:
    if target.startswith("//"):
        return None
    parsed = urlsplit(target)
    if parsed.scheme.casefold() in _EXTERNAL_SCHEMES:
        return None

    decoded_path = unquote(parsed.path)
    if decoded_path:
        base = repository if decoded_path.startswith("/") else source.parent
        target_path = (base / decoded_path.lstrip("/")).resolve()
    else:
        target_path = source.resolve()
    if target_path.is_dir():
        target_path = target_path / "README.md"
    return target_path, unquote(parsed.fragment).casefold()


def _markdown_anchors(path: Path) -> set[str]:
    anchors: set[str] = set()
    occurrences: dict[str, int] = {}
    explicit_anchor = re.compile(r"<(?:a|span)\s+(?:name|id)=[\"']([^\"']+)[\"']", re.IGNORECASE)
    for line in path.read_text(encoding="utf-8").splitlines():
        for match in explicit_anchor.finditer(line):
            anchors.add(match.group(1).casefold())
        heading = re.match(r"^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$", line)
        if heading is None:
            continue
        base = _github_slug(heading.group(1))
        suffix = occurrences.get(base, 0)
        occurrences[base] = suffix + 1
        anchors.add(base if suffix == 0 else f"{base}-{suffix}")
    return anchors


def _github_slug(value: str) -> str:
    without_markup = re.sub(r"[`*_~]", "", value)
    normalized = unicodedata.normalize("NFKD", without_markup).casefold()
    slug = "".join(
        character for character in normalized if character.isalnum() or character in " -_"
    )
    return re.sub(r"[\s-]+", "-", slug).strip("-")


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def _relative_to(repository: Path, path: Path) -> Path:
    try:
        return path.relative_to(repository)
    except ValueError:
        return path


def _display_path(path: Path) -> Path:
    resolved = path.resolve()
    try:
        return resolved.relative_to(Path.cwd().resolve())
    except ValueError:
        return resolved


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--scope",
        choices=("all", "narrative", "reference"),
        default="all",
        help="limit checks to one public documentation unit",
    )
    parser.add_argument(
        "--repository",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="repository root (defaults to the parent of scripts/)",
    )
    args = parser.parse_args(argv)
    findings = check_repository(args.repository, args.scope)
    if findings:
        for finding in findings:
            print(finding, file=sys.stderr)
        print(f"Documentation contract FAILED: {len(findings)} finding(s).", file=sys.stderr)
        return 1
    print(f"Documentation contract OK ({args.scope}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
