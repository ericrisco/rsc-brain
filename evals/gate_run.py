"""Run the success gates (G2/G3/G4) end to end against a configured instance.

The gates are the product's own definition of done, and until now nothing in this repository ran
them: every measurement was an ad-hoc script that no longer exists, so a number could not be
reproduced or re-earned after a change. This module is that instrument.

It drives the PRODUCTION composition root, real projects, real users with real personal access
tokens resolved through the real authentication path, and the production retriever — because a gate
measured through a hand-assembled graph measures the harness. Ingestion goes through the same
service the API uses, so extraction is whatever the configured models actually produce.

    uv run python -m evals.gate_run setup     # projects, topics, sources, users, PATs
    uv run python -m evals.gate_run ingest    # the 27-document corpus, real models
    uv run python -m evals.gate_run measure   # the 47 golden cases -> G2/G3/G4

`setup` and `ingest` are idempotent: a document already present is reported as a duplicate and
costs nothing, so an interrupted run resumes.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import secrets
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

import yaml

from evals.metrics import CaseOutcome, EvalReport, compute_eval_metrics
from evals.runner import eval_case_from_golden, observe
from evals.schema import Corpus, Golden, Taxonomy
from rsc_brain import runtime
from rsc_brain.identity.service import IdentityService
from rsc_brain.identity.sessions import membership_for
from rsc_brain.mcp.auth import authenticate
from rsc_brain.mcp.tools import do_recall
from rsc_brain.recall.retriever import PgRetriever
from rsc_brain.recall.timeline import build_timeline
from rsc_brain.stores.age_graph_store import AgeGraphStore

EVALS = Path(__file__).resolve().parent
STATE = EVALS / ".gate_run_state.json"
#: Each run generates the eval principals' password. It is never persisted and never reused: these
#: principals exist to hold topic grants, and a literal here would be a credential in source (§3.10).
_PRINCIPAL_SECRET = secrets.token_urlsafe(24)


@dataclass(frozen=True, slots=True)
class Principals:
    """The PAT per eval user, and the project id per slug.

    AUDIT-116: the tokens live here and **only** here — in memory, for the length of one run. An
    earlier version persisted them into the state file next to the project ids, and that file was
    committed. A credential that is written down is a credential that leaks; the run mints its own
    and revokes them when it is done.
    """

    tokens: dict[str, str]
    token_ids: dict[str, str]
    projects: dict[str, str]


def _load[T](model: type[T], name: str) -> T:
    loaded = model.model_validate(  # type: ignore[attr-defined]
        yaml.safe_load((EVALS / name).read_text(encoding="utf-8"))
    )
    return cast("T", loaded)


def _users() -> dict[str, dict[str, Any]]:
    raw = yaml.safe_load((EVALS / "users.yaml").read_text(encoding="utf-8"))
    users = raw["users"]
    if not isinstance(users, dict):
        raise TypeError("evals/users.yaml must define a users mapping")
    return {str(name): dict(spec) for name, spec in users.items()}


async def _setup() -> Principals:
    """Create the two projects, their taxonomy, their sources, and the four principals."""
    taxonomy = _load(Taxonomy, "taxonomy.yaml")
    corpus = _load(Corpus, "documents.yaml")
    dependencies = runtime.build("cli")
    try:
        identity = IdentityService(dependencies.sessionmaker)
        existing = {
            entry["slug"]: entry["id"] for entry in await identity.list_project_identities()
        }
        projects: dict[str, str] = {}
        for slug, spec in taxonomy.projects.items():
            projects[slug] = existing.get(slug) or await identity.create_project(slug, spec.name)
            known = set(await identity.list_topic_slugs(projects[slug]))
            for topic in spec.topics:
                if topic.slug not in known:
                    await identity.create_topic(
                        projects[slug],
                        topic.slug,
                        topic.name_en,
                        sensitivity=topic.sensitivity,
                    )
        await _sources(dependencies, corpus, projects)
        tokens, token_ids = await _mint(identity, projects)
        return Principals(tokens=tokens, token_ids=token_ids, projects=projects)
    finally:
        await dependencies.dispose()


async def _sources(dependencies: Any, corpus: Corpus, projects: dict[str, str]) -> None:
    from rsc_brain.scope import Principal, PrincipalType
    from rsc_brain.stores.relational.ingest_repository import IngestRepository

    repository = IngestRepository(dependencies.sessionmaker)
    wanted: dict[tuple[str, str], tuple[str, tuple[str, ...]]] = {}
    for document in corpus.documents:
        # One source row per (project, name); a name reused with different tags keeps the union, the
        # way an operator declaring a folder once would.
        key = (document.project, document.source)
        policy, tags = wanted.get(key, (document.policy, ()))
        wanted[key] = (policy, tuple(sorted(set(tags) | set(document.tags))))
    for (project, name), (policy, tags) in wanted.items():
        scope = Principal(
            id=projects[project], type=PrincipalType.HUMAN, can_curate=True, role="admin"
        ).scope_for(projects[project])
        rows = {row.name for row in await repository.list_sources(scope)}
        if name not in rows:
            await repository.create_source(
                scope, name=name, type_="folder", policy=policy, default_tags=list(tags)
            )


async def _approve_pending(dependencies: Any, projects: dict[str, str]) -> int:
    """Work the D13 approval gate as an authorized admin, the way the console does.

    Five of the 27 corpus documents are held for human approval — the sensitive ones, which is the
    point of the gate. `brain docs` cannot approve them and should not be able to: the CLI principal
    holds no topic authority on purpose (R01/AUDIT-089), so shell access never implies authority.
    Approval belongs to a principal that holds the topics, so the run creates one per project.
    """
    from rsc_brain.api.authz import decide_document
    from rsc_brain.identity.service import IdentityService as _Identity
    from rsc_brain.ingest.service import IngestService
    from rsc_brain.scope import PROJECT_ROLE_ADMIN, Principal, PrincipalType
    from rsc_brain.stores.relational.ingest_repository import IngestRepository

    identity = _Identity(dependencies.sessionmaker)
    repository = IngestRepository(dependencies.sessionmaker)
    service = IngestService(
        repository, runtime.build_pipeline(dependencies), data_dir=dependencies.data_dir
    )
    approved = 0
    for slug, project_id in projects.items():
        topics = tuple(await identity.list_topic_slugs(project_id))
        # A HUMAN principal, holding the project's topics: the gate refuses an agent ("not a human
        # principal"), which is the rule working — an automated caller does not get to clear the
        # human review a sensitive document was held for. So the run has a curator, and it is a
        # user with a membership, exactly like the operator who would do this in the console.
        curator = await _curator(identity, slug, project_id, topics)
        scope = Principal(
            id=curator,
            type=PrincipalType.HUMAN,
            can_curate=True,
            role=PROJECT_ROLE_ADMIN,
            allowed_topics=frozenset(topics),
        ).scope_for(project_id)
        pending = await repository.list_documents_by_status(scope, "pending_approval")
        for row in pending:
            await decide_document(dependencies.sessionmaker, scope, str(row.id))
            run = await service.approve(scope, str(row.id), approver=scope.principal_id)
            approved += 1
            print(
                f"approved {slug}/{row.logical_id}: {run.phase}, {run.claims_generated} claims",
                flush=True,
            )
    return approved


async def _curator(
    identity: IdentityService, slug: str, project_id: str, topics: tuple[str, ...]
) -> str:
    """The eval curator for one project: a real user with a membership holding every topic."""
    email = f"curator-{slug}@gate-run.test"
    try:
        invitation = await identity.invite_user(email, role="admin")
        user_id = await identity.accept_invitation(invitation.token, _PRINCIPAL_SECRET)
    except Exception:
        user_id = await _user_id(identity, email)
    if await membership_for(identity._sm, user_id, slug) is None:
        from rsc_brain.scope import PROJECT_ROLE_ADMIN

        await identity.add_membership(
            user_id, project_id, role=PROJECT_ROLE_ADMIN, allowed_topics=topics, can_curate=True
        )
    return user_id


async def _mint(
    identity: IdentityService, projects: dict[str, str]
) -> tuple[dict[str, str], dict[str, str]]:
    """Create the principals if absent and issue one short-lived PAT each, returned never stored."""
    tokens: dict[str, str] = {}
    token_ids: dict[str, str] = {}
    for name, spec in _users().items():
        project_id = projects[str(spec["project"])]
        email = f"{name}@gate-run.test"
        try:
            invitation = await identity.invite_user(email, role="member")
            user_id = await identity.accept_invitation(invitation.token, _PRINCIPAL_SECRET)
        except Exception:  # the principal already exists from an earlier run
            user_id = await _user_id(identity, email)
        # A membership is unique per (user, project), so a second run must reuse the one it made
        # rather than colliding. `sessions.membership_for` is the seam the console's own PAT route
        # uses for exactly this, and it is the only thing that returns the id `issue_pat` needs.
        membership = await membership_for(identity._sm, user_id, str(spec["project"]))
        if membership is None:
            membership = await identity.add_membership(
                user_id,
                project_id,
                allowed_topics=tuple(spec["allowed_topics"]),
                can_curate=bool(spec.get("can_curate", False)),
            )
        issued = await identity.issue_pat(membership, name=f"gate-{name}")
        tokens[name] = issued.token
        token_ids[name] = issued.id
    return tokens, token_ids


async def _revoke(identity: IdentityService, principals: Principals) -> None:
    """Leave no live credential behind, whether the run passed or failed."""
    for token_id in principals.token_ids.values():
        await identity.revoke_pat(token_id)


async def _user_id(identity: IdentityService, email: str) -> str:
    import uuid as _uuid

    from sqlalchemy import select

    from rsc_brain.stores.relational import models

    async with identity._sm() as session:
        found = await session.scalar(select(models.User.id).where(models.User.email == email))
    if found is None:
        raise LookupError(f"no principal {email}: run the setup phase first")
    return str(_uuid.UUID(str(found)))


async def _ingest(principals: Principals) -> dict[str, str]:
    """Ingest every corpus document, returning corpus-id -> runtime document id."""
    from rsc_brain.ingest.service import IngestService
    from rsc_brain.scope import Principal, PrincipalType
    from rsc_brain.stores.relational.ingest_repository import IngestRepository

    corpus = _load(Corpus, "documents.yaml")
    dependencies = runtime.build("cli")
    try:
        repository = IngestRepository(dependencies.sessionmaker)
        service = IngestService(
            repository,
            runtime.build_pipeline(dependencies),
            data_dir=dependencies.data_dir,
        )
        document_ids: dict[str, str] = {}
        for index, document in enumerate(corpus.documents, start=1):
            project_id = principals.projects[document.project]
            scope = Principal(
                id=project_id, type=PrincipalType.HUMAN, can_curate=True, role="admin"
            ).scope_for(project_id)
            outcome = await service.ingest_bytes(
                scope,
                _as_markdown(document).encode(),
                filename=f"{document.id}.md",
                source=document.source,
            )
            document_ids[document.id] = outcome.document_id
            print(
                f"[{index:2}/{len(corpus.documents)}] {document.id:24} "
                f"{outcome.status:18} {'duplicate' if outcome.duplicate else ''}",
                flush=True,
            )
        return document_ids
    finally:
        await dependencies.dispose()


def _degradation_of(result: Any) -> str | None:
    """The reason a verdict is worth less than it looks, when the surface carries one."""
    return getattr(result, "degraded", None)


def _as_markdown(document: Any) -> str:
    """Render one corpus document as the markdown this instrument ingests.

    The corpus is authored for `evals/generate_pdfs.py`, which renders each document — so a
    `kind: table` body is pipe-delimited rows with no GFM separator, because a *rendered* table needs
    none. Ingested as markdown, those rows are not a table at all: the parser flattens them into one
    prose line, the deterministic table path never runs, and the extractor is handed a smear of
    columns. Measured: `acme-invoice-table-en` became a single prose chunk and `e4` ("which invoice is
    for Initech?") could not be answered, because the customer column was gone.

    So a table document gets the separator row that makes it a table. This is a property of the
    harness, not of the product: to exercise the real table path, ingest the generated PDFs.
    """
    body = document.body.strip()
    if getattr(document, "kind", None) == "table":
        rows = [line.strip() for line in body.splitlines() if line.strip()]
        # Only a pipe-delimited header gets one. `acme-broken-table-en` has no pipes and is *meant*
        # to be unparseable — handing it a separator would repair the fixture the corpus needs broken.
        if rows and "|" in rows[0] and not any(set(row) <= set("|- :") for row in rows):
            columns = rows[0].count("|") + 1
            rows.insert(1, " | ".join(["---"] * columns))
        body = "\n".join(rows)
    return f"# {document.id}\n\n{body}\n"


async def _measure(
    principals: Principals, document_ids: dict[str, str]
) -> tuple[EvalReport, list[CaseOutcome]]:
    golden = _load(Golden, "golden.yaml")
    dependencies = runtime.build("cli")
    try:
        from rsc_brain.ontology.recall import OntologyRecall
        from rsc_brain.recall.reranker import LlmReranker

        retriever = PgRetriever(
            sessionmaker=dependencies.sessionmaker,
            gateway=dependencies.gateway,
            graph_store=AgeGraphStore(dependencies.sessionmaker),
            config=dependencies.recall_config,
            ontology=OntologyRecall(dependencies.sessionmaker),
            reranker=LlmReranker(dependencies.gateway) if dependencies.reranker_enabled else None,
        )
        outcomes = []
        for case in golden.cases:
            runnable = eval_case_from_golden(case, document_ids=document_ids)
            # The scope comes from the principal's own PAT through the real authentication path: a
            # fabricated scope would make every permission case prove nothing (R01/AUDIT-020).
            scope = await authenticate(
                dependencies.sessionmaker, f"Bearer {principals.tokens[case.user]}"
            )
            result: Any
            if runnable.surface == "timeline":
                # A timeline case is answered by the timeline surface, not by recall: that is the
                # whole point of `surface` (AUDIT-105 AC8). The topic is the one the case's evidence
                # is tagged with, and `general` is what the temporal corpus carries.
                result = await build_timeline(dependencies.sessionmaker, scope, topic="general")
                outcomes.append(observe(runnable, result))
            else:
                result = await do_recall(
                    retriever, dependencies.sessionmaker, scope, query=case.question, top_k=8
                )
                outcomes.append(observe(runnable, _as_recall_result(result)))
            mark = "ok " if outcomes[-1].passed else "XX "
            # AUDIT-121: print the reason when there is one. Chasing why a case abstained meant
            # re-running probes by hand for hours; the verdict now arrives with its own explanation.
            reason = f"  [{degraded}]" if (degraded := _degradation_of(result)) else ""
            print(
                f"{mark}{case.id:6} {case.family:14} found={outcomes[-1].found}{reason}", flush=True
            )
        return compute_eval_metrics(outcomes), outcomes
    finally:
        await dependencies.dispose()


def _as_recall_result(output: Any) -> Any:
    """Adapt the MCP tool's DTO to the domain result `observe` reads.

    Measuring through `do_recall` rather than the retriever keeps the guardrail and the audit in the
    path, which is where AUDIT-016 lives — but MCP deliberately does not expose similarity scores, so
    `score` is 0.0 here. That is safe for the verdict: `max_score` feeds the report and the tau
    calibration helper, never the pass/fail decision (`evals.metrics._passed`). Validity and
    provenance ARE carried, because the temporal expectations check them.
    """
    from datetime import date

    from rsc_brain.recall.interfaces import Fragment, RecallResult

    def _day(value: str | None) -> date | None:
        return date.fromisoformat(value[:10]) if value else None

    return RecallResult(
        found=output.found,
        fragments=tuple(
            Fragment(
                text=fragment.text,
                document_id=fragment.document_id,
                score=0.0,
                provenance={
                    "document": fragment.document,
                    "chunk_id": fragment.chunk_id,
                    "claim_ids": list(fragment.claim_ids),
                    "credibility": fragment.credibility,
                    "tags": list(fragment.tags),
                },
                valid_from=_day(fragment.valid_from),
                valid_to=_day(fragment.valid_to),
            )
            for fragment in output.fragments
        ),
        degraded=output.degraded,
    )


def _families(outcomes: Sequence[Any]) -> dict[str, dict[str, int]]:
    families: dict[str, dict[str, int]] = {}
    for outcome in outcomes:
        bucket = families.setdefault(outcome.family, {"passed": 0, "total": 0})
        bucket["total"] += 1
        bucket["passed"] += int(outcome.passed)
    return families


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("setup", "ingest", "measure", "all"))
    args = parser.parse_args(argv)

    async def _run() -> int:
        # The state file carries project and document IDENTIFIERS only. Never a token: see AUDIT-116.
        state: dict[str, Any] = json.loads(STATE.read_text()) if STATE.is_file() else {}
        dependencies = runtime.build("cli")
        try:
            identity = IdentityService(dependencies.sessionmaker)
            principals = await _setup()
            state["projects"] = principals.projects
            STATE.write_text(json.dumps(state, indent=2), encoding="utf-8")
            if args.phase == "setup":
                print(
                    f"setup: {len(principals.projects)} projects, "
                    f"{len(principals.tokens)} principals (tokens are per-run and not stored)"
                )
            try:
                if args.phase in {"ingest", "all"}:
                    state["documents"] = await _ingest(principals)
                    STATE.write_text(json.dumps(state, indent=2), encoding="utf-8")
                    held = await _approve_pending(dependencies, principals.projects)
                    print(f"approved {held} documents held at the D13 gate")
                if args.phase in {"measure", "all"}:
                    # AUDIT-119: without this map every expectation carrying a `document_id` compares
                    # a corpus id against a runtime UUID and fails — silently, and reported as a
                    # product failure. The state file lives in the checkout that ran `ingest`, so
                    # measuring from a different worktree is exactly how this happens. Refuse.
                    documents = state.get("documents") or {}
                    if not documents:
                        raise SystemExit(
                            "no document map in "
                            f"{STATE}: run the `ingest` phase in THIS checkout first. Measuring "
                            "without it turns every provenance expectation into a false failure."
                        )
                    report, outcomes = await _measure(principals, documents)
                    families = _families(outcomes)
                    print(json.dumps({"report": report.as_dict(), "families": families}, indent=2))
                    abstain = families.get("abstain", {"passed": 0, "total": 0})
                    print(
                        f"\nG4 (abstain family) = {abstain['passed']}/{abstain['total']}"
                        f"   G2 (permission leaks) = {report.permission_leaks}"
                    )
            finally:
                await _revoke(identity, principals)
            return 0
        finally:
            await dependencies.dispose()

    return asyncio.run(_run())


if __name__ == "__main__":
    sys.exit(main())
