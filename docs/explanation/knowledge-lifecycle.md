# Knowledge lifecycle
<!-- diataxis: explanation -->

rsc-brain treats company knowledge as a set of admitted, attributable claims rather than a copy of
every uploaded sentence. That distinction creates review, provenance, temporal, and confidence state
between a source document and a recall result.

## From bytes to a review decision

An intake stores the original bytes under a project-scoped, content-addressed path and records a
SHA-256 checksum. The same checksum is a no-op within one project, while the same file in another
project remains independent. A changed file with the same logical name becomes a new version.

The parse phase structures prose and tables, creates chunks, and proposes topic tags. These chunks
are durable so a reviewer can inspect them, but they have no embeddings and add nothing to the graph.
They are therefore absent from recall while approval is unresolved.

Source policy decides where the approval boundary falls. Manual and model-with-review policies stop
for a human decision. Source-declared tags can auto-approve, and model-selected tags can auto-approve
unless the source requires review for a proposed sensitive topic. Treating categorization as an
admission decision prevents an incorrect tag from becoming a permission bypass.

## Publication creates several linked views

Approval opens the publish phase. The pipeline embeds eligible chunks, extracts entities,
relationships, and atomic claims, then writes relational and graph state in one database transaction.
Malformed structured extraction is recorded and discarded instead of entering the graph.

Each claim retains its document and chunk provenance. Its initial credibility combines source
authority, extraction confidence, corroboration by independent sources, and freshness. The score is
evidence about a claim, not a guarantee that the claim is true.

Tables with unclear headers remain in review rather than becoming deterministic row claims. This
reduces automatic coverage, but it prevents an ambiguous column layout from being interpreted as a
confident relationship.

## Recall selects evidence, not prose answers

Recall searches vector and lexical indexes, fuses their rankings, and can expand through connected
graph entities. Project, topic, sensitivity, approval, and temporal constraints live in the storage
queries. Scoring then combines similarity, credibility, freshness, and importance.

A result below the configured relevance threshold produces an abstention and records a knowledge
gap. A successful result returns bounded fragments with document provenance, validity dates, current
state, and a disputed flag. The service does not synthesize an answer from those fragments, and it
marks them as untrusted data for the consuming agent.

This split keeps source evidence visible and lets the consuming application decide how to present it.
It also moves answer composition and prompt-injection handling to that consumer.

## Knowledge changes without erasing history

When a document changes, unchanged chunks retain their claims and credibility. Changed or removed
chunks close their former claims with a `valid_to` time and retire graph relationships that no other
active claim supports. Current recall excludes closed claims by default, while temporal queries can
select the appropriate validity window.

When a processing path includes the contradiction resolver, it compares semantically close claims
that share an entity. A higher-credibility claim can supersede a lower one; a close credibility tie
marks both as disputed. Superseded claims remain stored for provenance instead of being overwritten.
The release 0.13.0 background worker does not attach this resolver, so asynchronous ingestion does
not guarantee automatic contradiction evaluation.

Corrections follow the same historical model. An accepted correction creates a replacement claim and
closes the former one; sensitive corrections can wait for confirmation. Feedback changes credibility
within principal-specific limits, so repeated agent signals cannot move a claim without bound.

## Gaps can return to people

Abstentions accumulate as project-scoped gaps. Repeated human gaps can enter a hunting workflow that
routes a question to a responsible person by topic. A human answer becomes high-credibility knowledge
and closes the gap after the answer is accepted.

Delivery is explicit. The default hunting channel is `none`, so an installation without SMTP or Slack
records that no message was delivered instead of reporting a successful contact. Agent-only gaps stay
separate from the human hunting trigger.

The result is a loop rather than a one-time indexing job: sources introduce evidence, review admits
it, recall exposes eligible fragments, feedback and contradictions change confidence, and gaps invite
new evidence.

See [Ingest and query](../how-to/ingest-and-query.md) for the operational workflow and
[Security and tenancy](security-and-tenancy.md) for the permission boundary applied throughout this
lifecycle.
