"""Online migration safety (AUDIT-047/AUDIT-049 — R49, R52).

Two properties, both checkable without a cluster:

* **Ordering** — the migration must be able to run BEFORE anything whose readiness depends on the
  schema. On Kubernetes it currently cannot: the migrate Job is a ``post-install`` hook, and
  ``helm install --wait`` waits for the api Deployment to be Ready before running post-install hooks,
  while the api's readiness probe is ``brain verify``, which fails until the schema is at head. That is a
  deadlock, not a race — the documented install command cannot succeed on a fresh cluster.
* **Bounded impact** — a migration on a live instance must not be able to block traffic indefinitely. A
  plain ``CREATE INDEX`` takes ACCESS EXCLUSIVE, and with no ``lock_timeout`` a migration that cannot get
  its lock queues *ahead of* every subsequent reader, so one blocked migration stops the product.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml
from sqlalchemy import text

pytestmark = pytest.mark.integration

REPO_ROOT = Path(__file__).resolve().parents[2]
CHART = REPO_ROOT / "deploy" / "helm" / "rsc-brain"
VERSIONS = REPO_ROOT / "src" / "rsc_brain" / "stores" / "relational" / "alembic" / "versions"

#: Tables that grow with the corpus. An exclusive lock on one of these is an outage; on a small
#: configuration table it is microseconds, so the rule is aimed where it matters.
LARGE_TABLES = frozenset({"chunks", "claims", "documents", "audit_log", "token_usage", "hunts"})

_CREATE_INDEX = re.compile(r"CREATE\s+INDEX(?P<concurrently>\s+CONCURRENTLY)?", re.IGNORECASE)


def _migration_files() -> list[Path]:
    return sorted(p for p in VERSIONS.glob("*.py") if not p.name.startswith("__"))


def _rendered() -> list[dict]:
    """The chart as Kubernetes would receive it.

    Rendered rather than parsed as YAML: the templates are Go templates, so reading them directly tells
    you what was written, not what gets applied — and the finding is about what gets applied.
    """
    if shutil.which("helm") is None:
        pytest.skip("helm not installed (runs in CI)")
    out = subprocess.run(
        ["helm", "template", "rsc", str(CHART), "--set", "ingress.enabled=false"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return [doc for doc in yaml.safe_load_all(out) if doc]


def _kind(docs: list[dict], kind: str, component: str) -> dict:
    for doc in docs:
        labels = (doc.get("metadata") or {}).get("labels") or {}
        if doc.get("kind") == kind and labels.get("app.kubernetes.io/component") == component:
            return doc
    raise AssertionError(f"no {kind} for component {component!r} in the rendered chart")


# --------------------------------------------------------------------------- #
# R49 — the migration runs before schema-dependent readiness
# --------------------------------------------------------------------------- #


def test_the_migration_does_not_wait_for_schema_dependent_readiness() -> None:
    """A ``post-install`` hook runs after ``--wait`` has already waited for the api.

    The api cannot become Ready until the schema is at head, and the schema cannot reach head until the
    hook runs. ``helm install --wait`` — the command the chart's own e2e script uses — therefore times
    out on a clean cluster with nothing wrong.
    """
    job = _kind(_rendered(), "Job", "migrate")
    hooks = (job.get("metadata", {}).get("annotations") or {}).get("helm.sh/hook", "")

    assert "post-install" not in hooks, (
        "the migrate Job is a post-install hook, so `helm install --wait` waits for an api whose "
        f"readiness needs the schema the hook has not applied yet; hooks={hooks!r}"
    )


def test_the_app_waits_for_the_schema_instead_of_being_waited_on() -> None:
    """Something has to gate the app on the schema, and it must not be the readiness probe.

    Readiness answers "can this pod serve"; it is also what an installer waits on. If the only gate is
    readiness, the installer waits for the app and the app waits for the migration. An init container
    inverts that: the pod stays in Init until the schema is ready, and readiness stays a health signal.
    """
    docs = _rendered()
    for component in ("api", "worker"):
        spec = _kind(docs, "Deployment", component)["spec"]["template"]["spec"]
        init = spec.get("initContainers") or []
        rendered = yaml.safe_dump(init)
        assert init and "schema" in rendered, (
            f"the {component} Deployment has no init container waiting for the schema, so the only "
            "thing gating it on the migration is its readiness probe — which is what the installer is "
            "waiting on"
        )


# --------------------------------------------------------------------------- #
# R52 — bounded locks, and indexes built without blocking writes
# --------------------------------------------------------------------------- #


def test_indexes_on_growing_tables_are_built_concurrently() -> None:
    """``CREATE INDEX`` on a large table takes ACCESS EXCLUSIVE for the whole build.

    Every write to that table waits, and so does every reader queued behind the lock request. On a
    corpus of any size that is a visible outage during an upgrade the operator was told was online.
    """
    offenders: list[str] = []
    for path in _migration_files():
        source = path.read_text()
        for match in _CREATE_INDEX.finditer(source):
            if match.group("concurrently"):
                continue
            tail = source[match.end() : match.end() + 400]
            table = next(
                (t for t in LARGE_TABLES if re.search(rf"\bON\s+{t}\b", tail, re.IGNORECASE)), None
            )
            if table:
                offenders.append(f"{path.name}: CREATE INDEX on {table} without CONCURRENTLY")
    assert not offenders, "\n".join(offenders)


async def test_a_migration_that_cannot_take_its_lock_gives_up(migrated_dsn: str) -> None:
    """With no ``lock_timeout``, a blocked migration waits forever — and blocks everything behind it.

    A pending lock request queues AHEAD of every later reader, so one migration stuck behind a long
    transaction stops the product entirely, with nothing to time it out. Failing fast is recoverable; an
    indefinite stall during an upgrade is not.

    Driven through the real runner: another session holds ACCESS EXCLUSIVE on ``alembic_version``, which
    every migration must read, and the runner is given a generous deadline of its own. Today it hangs
    until that deadline; it has to raise instead.
    """
    import asyncio
    import os

    from rsc_brain.stores.relational.database import DSN_ENV_VAR, make_engine, make_sessionmaker
    from rsc_brain.stores.relational.migrations import upgrade_to_head

    blocker_engine = make_engine(migrated_dsn)
    blocker_sessionmaker = make_sessionmaker(blocker_engine)
    previous = os.environ.get(DSN_ENV_VAR)
    os.environ[DSN_ENV_VAR] = migrated_dsn
    try:
        async with blocker_sessionmaker() as blocker:
            await blocker.execute(text("BEGIN"))
            await blocker.execute(text("LOCK TABLE alembic_version IN ACCESS EXCLUSIVE MODE"))
            try:
                # 20s: comfortably more than any bounded lock wait, far less than "forever".
                with pytest.raises(Exception) as raised:
                    await asyncio.wait_for(asyncio.to_thread(upgrade_to_head), timeout=20)
                assert not isinstance(raised.value, TimeoutError), (
                    "the migration was still waiting for its lock when the test's own deadline "
                    "expired: nothing bounds it, so in production it waits forever while every reader "
                    "queues behind its lock request"
                )
                assert re.search(r"(?i)lock|timeout|canceling", str(raised.value)), (
                    f"the migration failed, but not on the lock: {raised.value!r}"
                )
            finally:
                await blocker.execute(text("ROLLBACK"))
    finally:
        if previous is None:
            os.environ.pop(DSN_ENV_VAR, None)
        else:
            os.environ[DSN_ENV_VAR] = previous
        await blocker_engine.dispose()
