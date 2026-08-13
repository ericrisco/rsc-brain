"""AUDIT-066: a fresh install's owner could ingest knowledge and then never see it."""

from __future__ import annotations


def test_the_default_topic_slug_is_shared_not_duplicated() -> None:
    """The bootstrap grant and the ingestion fallback must name the same topic. If they drift, the
    owner is granted a topic nothing is ever tagged with, which fails silently and looks exactly
    like an empty knowledge base."""
    from rsc_brain.identity.service import DEFAULT_TOPIC_SLUG
    from rsc_brain.ingest.pipeline import PipelineConfig

    assert PipelineConfig().default_tag == DEFAULT_TOPIC_SLUG


def test_bootstrap_ensures_the_default_topic_before_granting_it() -> None:
    """The grant was `list_topic_slugs(project_id)` — a snapshot taken at bootstrap, when the
    project has no topics at all, because topics are created lazily during ingestion. So the first
    admin's `allowed_topics` froze as `{}` forever: they ingested a document, asked for it, and got
    `found: false` — indistinguishable from "nothing there", because FR-4.3 requires exactly that.
    Observed on a real install: 4 correct claims in the database, invisible to the only human.

    Verified by reading the source rather than a live database, because the defect is the ORDER of
    two calls, and ordering is what a unit test can hold still."""
    import inspect

    from rsc_brain.deploy import bootstrap

    source = inspect.getsource(bootstrap)
    ensure_at = source.find("ensure_default_topic")
    grant_at = source.find("list_topic_slugs")
    assert ensure_at != -1, (
        "bootstrap never ensures the default topic exists, so its grant snapshot is empty on a "
        "fresh install and the owner cannot see what they ingest"
    )
    if grant_at != -1:
        assert ensure_at < grant_at, "the topic must exist before the grant snapshot is taken"
