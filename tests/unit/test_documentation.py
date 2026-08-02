"""Deterministic contracts for public product documentation."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from scripts.check_docs import (
    check_banned_terms,
    check_local_links,
    check_navigation,
    check_private_paths,
    check_repository,
    check_stale_markers,
    collect_cli,
    collect_config,
    collect_documented_tokens,
    collect_mcp,
    collect_openapi,
    collect_public_pages,
    missing_coverage,
)

REPO_ROOT = Path(__file__).resolve().parents[2]


def _page(root: Path, relative: str, content: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def test_broken_local_link_reports_target_and_line(tmp_path: Path) -> None:
    page = _page(tmp_path, "docs/index.md", "# Docs\n\n[Missing](missing.md)\n")

    findings = check_local_links(tmp_path, [page])

    assert [(finding.rule, finding.line) for finding in findings] == [("link", 3)]
    assert "missing.md" in findings[0].message


def test_local_link_accepts_an_existing_heading_anchor(tmp_path: Path) -> None:
    target = _page(tmp_path, "docs/reference.md", "# API reference\n\n## Error model\n")
    page = _page(tmp_path, "README.md", "[Errors](docs/reference.md#error-model)\n")

    assert check_local_links(tmp_path, [page, target]) == []


def test_navigation_reports_an_orphan_public_page(tmp_path: Path) -> None:
    root = _page(tmp_path, "README.md", "# Product\n\n[Docs](docs/index.md)\n")
    index = _page(tmp_path, "docs/index.md", "# Documentation\n")
    orphan = _page(tmp_path, "docs/explanation/orphan.md", "# Orphan\n")

    findings = check_navigation(tmp_path, [root, index, orphan], [root, index])

    assert len(findings) == 1
    assert findings[0].rule == "navigation"
    assert findings[0].path == Path("docs/explanation/orphan.md")


@pytest.mark.parametrize(
    "generated_directory",
    ["node_modules", ".venv", ".next", "__pycache__", ".dart_tool", "build"],
)
def test_public_page_collection_ignores_generated_directories(
    tmp_path: Path,
    generated_directory: str,
) -> None:
    readme = _page(tmp_path, "README.md", "# Product\n")
    generated = _page(
        tmp_path,
        f"apps/admin/{generated_directory}/dependency/README.md",
        "# Third-party generated documentation\n",
    )

    pages = collect_public_pages(tmp_path)

    assert readme in pages
    assert generated not in pages


@pytest.mark.parametrize(
    "term",
    [
        "simply",
        "just",
        "easily",
        "effortless",
        "effortlessly",
        "seamless",
        "seamlessly",
        "blazing-fast",
        "blazing fast",
        "supercharge",
        "leverage",
        "utilize",
        "in order to",
    ],
)
def test_banned_term_reports_exact_phrase_and_line(tmp_path: Path, term: str) -> None:
    page = _page(tmp_path, "README.md", f"# Product\n\nYou can {term} operate it.\n")

    findings = check_banned_terms([page])

    assert len(findings) == 1
    assert findings[0].rule == "banned-term"
    assert findings[0].line == 3
    assert term in findings[0].message.lower()


def test_banned_term_matching_respects_word_boundaries(tmp_path: Path) -> None:
    page = _page(tmp_path, "README.md", "# Product\n\nA justified adjustment.\n")

    assert check_banned_terms([page]) == []


@pytest.mark.parametrize("private_path", ["02-DOCS/", "01-TOOLS/", ".rsc/"])
def test_private_path_dependency_reports_prefix(tmp_path: Path, private_path: str) -> None:
    page = _page(tmp_path, "docs/index.md", f"Read [{private_path}]({private_path}index.md).\n")

    findings = check_private_paths([page])

    assert len(findings) == 1
    assert findings[0].rule == "private-path"
    assert findings[0].line == 1
    assert private_path in findings[0].message


@pytest.mark.parametrize(
    "claim",
    [
        "This repository is still at Sprint 0.",
        "The API arrives in a future SPEC.",
        "The console is a bootstrap-only shell.",
    ],
)
def test_stale_marker_reports_current_claim_and_line(tmp_path: Path, claim: str) -> None:
    page = _page(tmp_path, "README.md", f"# Status\n\n{claim}\n")

    findings = check_stale_markers([page])

    assert len(findings) == 1
    assert findings[0].rule == "stale-marker"
    assert findings[0].line == 3


def test_openapi_inventory_derives_current_operations(tmp_path: Path) -> None:
    schema = {
        "openapi": "3.1.0",
        "paths": {
            "/health": {"get": {"summary": "Health"}, "parameters": []},
            "/documents": {"post": {"summary": "Upload"}},
        },
    }
    path = tmp_path / "apps" / "admin" / "openapi.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(schema), encoding="utf-8")

    assert collect_openapi(tmp_path) == {"GET /health", "POST /documents"}


def test_cli_inventory_walks_nested_registered_commands() -> None:
    inventory = collect_cli(REPO_ROOT)

    assert "brain init" in inventory
    assert "brain users" in inventory
    assert "brain users invite" in inventory


def test_mcp_inventory_derives_decorated_tool_names(tmp_path: Path) -> None:
    path = tmp_path / "src" / "rsc_brain" / "mcp" / "server.py"
    path.parent.mkdir(parents=True)
    path.write_text(
        """\
def register(server):
    @server.tool(description="Read")
    async def recall(query: str):
        return query

    @server.tool(
        description="Write",
    )
    async def submit_knowledge(body: str):
        return body
""",
        encoding="utf-8",
    )

    assert collect_mcp(tmp_path) == {"recall", "submit_knowledge"}


def test_config_inventory_walks_supported_nested_fields() -> None:
    inventory = collect_config(REPO_ROOT)

    assert "hardware_profile" in inventory
    assert "capabilities.extractor.provider" in inventory
    assert "recall.weights.similarity" in inventory
    assert "limits.json_body_bytes" in inventory


def test_openapi_cli_mcp_and_config_coverage_uses_visible_exact_tokens(tmp_path: Path) -> None:
    page = _page(
        tmp_path,
        "docs/reference/interfaces.md",
        "Use `GET /health`, `brain init`, `recall`, and `recall.tau`.\n",
    )

    documented = collect_documented_tokens([page])
    inventory = {"GET /health", "brain init", "recall", "recall.tau", "POST /documents"}

    assert documented == {"GET /health", "brain init", "recall", "recall.tau"}
    assert missing_coverage(inventory, documented) == {"POST /documents"}


def test_repository_documentation_contract() -> None:
    findings = check_repository(REPO_ROOT)

    assert findings == [], "\n" + "\n".join(str(finding) for finding in findings)


def test_private_model_overlay_is_ignored_by_git() -> None:
    result = subprocess.run(
        ["git", "check-ignore", "--quiet", "deploy/compose.models.yml"],
        cwd=REPO_ROOT,
        check=False,
    )

    assert result.returncode == 0


def test_upgrade_preflight_runs_inside_each_packaged_target() -> None:
    guide = (REPO_ROOT / "docs/how-to/upgrade.md").read_text(encoding="utf-8")

    assert "exec api brain preflight --json" in guide
    assert "kubectl -n rsc-brain exec deploy/rsc-brain-api -- brain preflight --json" in guide


def test_ingest_guide_provisions_topic_authority_before_upload() -> None:
    guide = " ".join(
        (REPO_ROOT / "docs/how-to/ingest-and-query.md").read_text(encoding="utf-8").split()
    )

    token_step = guide.index('read -rsp "rsc-brain PAT: "')
    topic_step = guide.index("${BRAIN_URL}/api/v1/admin/topics")
    upload_step = guide.index("${BRAIN_URL}/api/v1/projects/${BRAIN_PROJECT}/documents")

    assert token_step < topic_step < upload_step
    assert '"slug":"general"' in guide.replace(" ", "")


def test_eval_guide_names_the_must_find_metric_by_its_actual_semantics() -> None:
    guide = (REPO_ROOT / "evals/README.md").read_text(encoding="utf-8")

    assert "retrieval precision over must-find cases" not in guide
    assert "must-find hit rate" in guide


def test_public_origin_documents_the_mcp_dns_rebinding_boundary() -> None:
    reference = (REPO_ROOT / "docs/reference/configuration.md").read_text(encoding="utf-8")
    troubleshooting = (REPO_ROOT / "docs/how-to/troubleshooting.md").read_text(encoding="utf-8")

    assert "MCP Host and Origin allow-list" in reference
    assert "IDNA punycode" in reference
    assert "HTTP `421`" in troubleshooting
    assert "RSC_BRAIN_INGRESS__PUBLIC_ORIGIN" in troubleshooting
