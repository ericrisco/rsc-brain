"""Regression contracts for Helm deployment boundaries."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
HELM = REPO_ROOT / "deploy" / "helm"
CHART = HELM / "rsc-brain"


def _read(*parts: str) -> str:
    return (REPO_ROOT.joinpath(*parts)).read_text(encoding="utf-8")


def _render_with_sentinel_env() -> list[dict[str, Any]]:
    helm = shutil.which("helm")
    assert helm is not None, "Helm is required to verify the chart's rendered security boundary"
    app_secret_ref = {
        "name": "APP_SENTINEL",
        "valueFrom": {"secretKeyRef": {"name": "app-secret", "key": "token"}},
    }
    console_value = {"name": "CONSOLE_SENTINEL", "value": "console-only"}
    rendered = subprocess.run(
        [
            helm,
            "template",
            "sentinel",
            str(CHART),
            "--set-json",
            f"extraEnv={json.dumps([app_secret_ref])}",
            "--set-json",
            f"console.extraEnv={json.dumps([console_value])}",
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return [document for document in yaml.safe_load_all(rendered) if isinstance(document, dict)]


def _deployment_env(documents: list[dict[str, Any]], component: str) -> dict[str, dict[str, Any]]:
    for document in documents:
        if document.get("kind") != "Deployment":
            continue
        labels = document.get("metadata", {}).get("labels", {})
        if labels.get("app.kubernetes.io/component") != component:
            continue
        container = document["spec"]["template"]["spec"]["containers"][0]
        return {entry["name"]: entry for entry in container.get("env", [])}
    raise AssertionError(f"rendered chart has no {component} Deployment")


def _bash_block_after(markdown: str, heading: str) -> str:
    section = markdown.split(heading, 1)[1]
    return section.split("```bash\n", 1)[1].split("\n```", 1)[0]


def test_e2e_uses_real_console_handlers_and_the_canonical_proxy_path() -> None:
    e2e = _read("deploy", "helm", "e2e.sh")

    assert "/api/auth/session" not in e2e
    assert "/api/auth/login" in e2e
    assert "/api/proxy/projects" not in e2e
    assert "/api/proxy/api/v1/admin/projects" in e2e
    assert (REPO_ROOT / "apps" / "admin" / "app" / "api" / "auth" / "login" / "route.ts").is_file()
    assert (
        REPO_ROOT / "apps" / "admin" / "app" / "api" / "proxy" / "[...path]" / "route.ts"
    ).is_file()


def test_e2e_pins_each_ingress_owner_to_its_expected_status() -> None:
    e2e = _read("deploy", "helm", "e2e.sh")
    expected_probes = (
        ("service", "/api/v1/admin/projects", 401),
        ("service", "/mcp", 406),
        ("service", "/oauth/authorize", 401),
        ("service", "/.well-known/oauth-authorization-server", 200),
        ("service", "/metrics", 401),
        ("console", "/", 200),
        ("console", "/api/auth/login", 405),
        ("console", "/api/proxy/api/v1/admin/projects", 401),
    )

    for owner, path, status in expected_probes:
        assert f'"{owner}|{path}|{status}"' in e2e
    assert "RSC_BRAIN_INGRESS__PUBLIC_ORIGIN" in e2e
    assert "http://rsc-brain.local" in e2e
    assert '"$code" == "000" || "$code" == "404"' not in e2e


def test_application_extra_env_does_not_leak_into_the_console() -> None:
    """A rendered secretRef belongs only to Python workloads, not to the Next.js console."""
    documents = _render_with_sentinel_env()
    api_env = _deployment_env(documents, "api")
    worker_env = _deployment_env(documents, "worker")
    console_env = _deployment_env(documents, "console")

    expected_ref = {"secretKeyRef": {"name": "app-secret", "key": "token"}}
    assert api_env["APP_SENTINEL"]["valueFrom"] == expected_ref
    assert worker_env["APP_SENTINEL"]["valueFrom"] == expected_ref
    assert "APP_SENTINEL" not in console_env
    assert "CONSOLE_SENTINEL" not in api_env
    assert "CONSOLE_SENTINEL" not in worker_env
    assert console_env["CONSOLE_SENTINEL"]["value"] == "console-only"


def test_render_example_keeps_generated_secrets_out_of_a_public_tmp_file() -> None:
    """The render lives in a private subshell and is deleted as soon as review ends."""
    readme = _read("deploy", "helm", "rsc-brain", "README.md")
    notes = _read("deploy", "helm", "rsc-brain", "templates", "NOTES.txt")
    block = _bash_block_after(readme, "## Install")

    assert "> /tmp/rsc-brain-rendered.yaml" not in readme
    assert "\n(\n  umask 077\n" in f"\n{block}\n"
    assert "mktemp" in block
    assert "trap 'rm -f -- \"$rendered\"' EXIT" in block
    assert block.rstrip().endswith(")")
    assert "deleted immediately after review" in readme
    assert "Helm render output" in notes
    assert "NEVER printed here or in the templates" not in notes


def test_breaking_extra_env_contract_has_a_chart_version_and_migration_note() -> None:
    chart = yaml.safe_load((CHART / "Chart.yaml").read_text(encoding="utf-8"))
    values = (CHART / "values.yaml").read_text(encoding="utf-8")
    readme = (CHART / "README.md").read_text(encoding="utf-8")
    parity = (HELM / "PARITY.md").read_text(encoding="utf-8")

    assert chart["version"] == "0.14.0"
    assert chart["appVersion"] == "0.13.0"
    assert "## Upgrade from chart 0.13.x" in readme
    assert "top-level `extraEnv` to `console.extraEnv`" in readme
    assert "Chart 0.14.0" in values
    assert "Chart 0.14.0 migration" in parity
    upgrade = _bash_block_after(readme, "## Upgrade from chart 0.13.x")
    assert "-f values.production.yaml" in upgrade
    assert "--reuse-values" not in upgrade
