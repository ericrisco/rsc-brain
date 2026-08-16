"""SPEC release-identity: the two surfaces that report the identity.

Measured on a real host before this existed: every candidate route 404'd, no response header carried
the version, and the FastAPI `version=` metadata was unreachable because the edge does not expose the
OpenAPI document. The consequence was written down in the upgrade runbook, whose step 6 tells the
operator to *record the currently deployed application tag* — a tag that is always `latest`, on an
instance that cannot be asked.

Two properties carry the weight here, and both are about what the endpoint must **not** need:

- it answers without a credential, so monitoring and support can use it;
- it answers without a database, so a degraded instance still identifies itself — which is exactly
  when someone is asking.

The second is tested by wiring an app with no database at all, rather than by mocking one. A mock
proves the code path; an absent dependency proves the requirement.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from rsc_brain.api.version import router as version_router
from rsc_brain.identity_release import public, resolve

REPO = Path(__file__).resolve().parents[2]
ROUTE = "/api/v1/version"


def _app_with_no_database() -> FastAPI:
    """The endpoint's contract is that it needs nothing. This app gives it nothing."""
    app = FastAPI()
    app.include_router(version_router)
    return app


async def _get(path: str = ROUTE, **kwargs: object) -> tuple[int, dict[str, object]]:
    transport = ASGITransport(app=_app_with_no_database())
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get(path, **kwargs)  # type: ignore[arg-type]
    try:
        return response.status_code, response.json()
    except ValueError:
        return response.status_code, {}


class TestTheEndpoint:
    async def test_it_answers_without_a_credential(self) -> None:
        status, body = await _get()
        assert status == 200, "the version endpoint requires authentication; it must not"
        assert body["version"]

    async def test_it_answers_with_no_database_wired(self) -> None:
        """The app under test has no database, no sessionmaker, no lifespan. It still answers."""
        status, _ = await _get()
        assert status == 200

    async def test_it_returns_the_public_form_and_nothing_else(self) -> None:
        _, body = await _get()
        assert set(body) == {"version"}, (
            f"the response carries more than the version: {sorted(body)} — configuration, routes "
            "and component inventory are all disclosure the spec forbids"
        )

    async def test_it_equals_the_public_reduction_of_this_build(self) -> None:
        _, body = await _get()
        assert body["version"] == public()

    async def test_a_credential_is_neither_required_nor_honoured(self) -> None:
        """Passing one must not change the answer: there is no privileged version."""
        _, anonymous = await _get()
        _, with_token = await _get(headers={"Authorization": "Bearer whatever"})
        assert anonymous == with_token

    async def test_it_never_leaks_the_source_revision(self) -> None:
        _, body = await _get()
        assert "g" + "0" * 7 not in str(body["version"])
        assert not any(token in str(body["version"]) for token in ("commit", "sha", "gb440e6e")), (
            "the public answer must carry no source revision (clarify Q1)"
        )


class TestTheEndpointDependsOnNothing:
    """Asserted structurally as well as behaviourally: a future dependency added to this route would
    reintroduce the failure mode the route exists to survive, and a passing behavioural test on a
    healthy app would not notice."""

    def test_the_route_declares_no_dependencies(self) -> None:
        source = (REPO / "src" / "rsc_brain" / "api" / "version.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for default in node.args.defaults + list(node.args.kw_defaults):
                    rendered = ast.unparse(default) if default is not None else ""
                    assert "Depends" not in rendered, (
                        f"the version route declares a dependency ({rendered}); it must answer "
                        "while the database and every provider are unreachable"
                    )

    def test_the_module_imports_no_store_or_gateway(self) -> None:
        """Checked over the parsed imports, not the file text.

        A substring search matches this module's own explanation of *why* it imports none of them —
        the fourth time in this project that an over-broad grep flagged prose describing a rule as
        though it broke it. Prose about a dependency is not a dependency.
        """
        source = (REPO / "src" / "rsc_brain" / "api" / "version.py").read_text(encoding="utf-8")
        imported: set[str] = set()
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Import):
                imported.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module)

        for forbidden in ("stores", "gateway", "runtime", "identity.service", "scope"):
            offending = [name for name in imported if forbidden in name]
            assert not offending, (
                f"the version route imports {offending}, which makes its answer depend on "
                "something that can be down"
            )


class TestTheCliSurface:
    """Read from the parsed command tree, never from rendered help output — the terminal-width trap
    this repository already paid for once (AUDIT-086's neighbour)."""

    def test_the_cli_reports_the_full_form(self) -> None:
        source = (REPO / "src" / "rsc_brain" / "cli" / "main.py").read_text(encoding="utf-8")
        assert "identity_release" in source, (
            "`brain --version` still prints the package version, which reads 0.13.0 on a build "
            "forty-nine commits past the tag"
        )

    def test_the_cli_prints_the_full_form_not_the_public_one(self) -> None:
        """Support needs the exact build; only the HTTP answer is deliberately coarse.

        Resolved through the import, because the CLI aliases what it imports — checking the called
        name alone would pass on `public as build_identity`, which is the mistake this guards.
        """
        source = (REPO / "src" / "rsc_brain" / "cli" / "main.py").read_text(encoding="utf-8")
        tree = ast.parse(source)

        aliases: dict[str, str] = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module == "rsc_brain.identity_release":
                aliases.update({alias.asname or alias.name: alias.name for alias in node.names})
        assert aliases, "the CLI imports nothing from the identity module"

        called = {
            node.func.id
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        }
        printed = {aliases[name] for name in called & aliases.keys()}
        assert "full" in printed, f"the CLI does not print the full form; it calls {printed}"
        assert "public" not in printed, (
            "the CLI prints the coarse public form, so two different development builds would be "
            "indistinguishable on the one surface that must tell them apart"
        )


class TestTheDocumentedContract:
    def test_the_route_is_documented_where_the_gate_looks(self) -> None:
        """`scripts/check_docs.py` fails the build for an undocumented public operation. The doc
        entry is part of this change, not a follow-up."""
        reference = (REPO / "docs" / "reference" / "rest-api.md").read_text(encoding="utf-8")
        assert f"GET {ROUTE}" in reference or f"`{ROUTE}`" in reference

    def test_the_configuration_reference_denies_the_override(self) -> None:
        """R7: setting a version-looking variable is the obvious wrong thing to try."""
        configuration = (REPO / "docs" / "reference" / "configuration.md").read_text(
            encoding="utf-8"
        )
        assert "RSC_BRAIN_BUILD_IDENTITY" in configuration, (
            "nothing tells an operator that the build identity comes from the artifact and cannot "
            "be set by the deployment"
        )


@pytest.mark.parametrize("stamp", ["v0.13.0", "v0.13.0-49-gb440e6e", None])
def test_the_two_surfaces_never_disagree(stamp: str | None) -> None:
    """The invariant across surfaces: the public form is a reduction of the full one, always."""
    identity = resolve(stamp)
    assert identity.version in identity.full or identity.full.startswith(identity.version)
