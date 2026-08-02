# Ingest a document and query its knowledge
<!-- diataxis: how-to -->

Use this procedure after the API, worker, database, and all five model capabilities are running.
The [getting-started tutorial](../tutorials/getting-started.md) proves local readiness but does not
start a worker or a model provider.

Release 0.13.0 accepts deployed documents through the authenticated REST upload below. The Compose
and Helm layouts include an inbox mount, but no packaged process starts the folder watcher. Copying a
file into that mount does not create a document or queue entry.

## Prepare access

You need:

- a project slug;
- a personal access token for a project member with access to the document's topics; and
- an MCP client connected to the same instance.

Use the `default` project created by `brain init`, or another project where the user already has an
explicit membership and topic grants. `brain projects create` creates only the project record in
0.13.0; it does not attach the creator as a member. A signed-in member creates a project-scoped
personal access token from **Connections** in the administration console. The token is displayed
once; store it in a secret manager and do not commit it.

Set shell variables without putting the token in shell history:

```bash
export BRAIN_URL="https://brain.example.com"
export BRAIN_PROJECT="default"
read -rsp "rsc-brain PAT: " BRAIN_PAT; export BRAIN_PAT; echo
```

## Create the first topic grant

A clean `default` project has no topics, so its administrator initially cannot retrieve topical
knowledge. After issuing the PAT, create the first topic through the project-scoped admin endpoint:

```bash
curl --fail-with-body \
  -X POST \
  -H "Authorization: Bearer ${BRAIN_PAT}" \
  -H "Content-Type: application/json" \
  --data '{"slug":"general","name":"General","sensitivity":0}' \
  "${BRAIN_URL}/api/v1/admin/topics"
```

The response is HTTP `201` and includes `general` in `granted_topics`; topic creation explicitly
grants the author authority over that topic. Skip this step when the PAT's membership already has the
required topic grants.

## Prove the source volume is writable

Run a live write from both application processes before the first upload. For the canonical Compose
file plus the model overlay:

```bash
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml \
  -f deploy/compose.models.yml \
  exec api sh -ceu 'p=/var/lib/rsc-brain/data/.write-probe; : > "$p"; rm "$p"'
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml \
  -f deploy/compose.models.yml \
  exec worker sh -ceu 'p=/var/lib/rsc-brain/data/.write-probe; : > "$p"; rm "$p"'
```

For a Helm release named `rsc-brain`:

```bash
kubectl -n rsc-brain exec deploy/rsc-brain-api -- \
  sh -ceu 'p=/var/lib/rsc-brain/data/.write-probe; : > "$p"; rm "$p"'
kubectl -n rsc-brain exec deploy/rsc-brain-worker -- \
  sh -ceu 'p=/var/lib/rsc-brain/data/.write-probe; : > "$p"; rm "$p"'
```

Both commands must exit `0`. A mounted named volume or bound PVC is insufficient evidence: the
Compose container runs as UID `10001`, Helm runs it as UID `1000`, and neither packaging target
initializes volume ownership. Provision writable ownership with the storage backend before retrying.

## Upload the document

Upload a Markdown file with the project-scoped token:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${BRAIN_PAT}" \
  -F "file=@handbook.md;type=text/markdown" \
  "${BRAIN_URL}/api/v1/projects/${BRAIN_PROJECT}/documents"
```

The API returns HTTP `202` with a `document_id`, pipeline `status`, and `duplicate` flag. The path
project must match the project bound to the token. A mismatch is denied rather than switching the
token to another project.

PDF and OCR ingestion requires an operator-installed Docling backend, which is not part of the
locked default environment. Install and validate that parser separately before replacing the
Markdown file in this procedure with a PDF.

## Follow processing

Inspect the authenticated token's ingestion runs:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${BRAIN_PAT}" \
  "${BRAIN_URL}/api/v1/ingest/runs"
```

A completed run reports its phase, completed stages, chunk and claim counts, discarded chunks, and
any error. Model or parser failures appear here even when the initial upload was accepted.

## Review held documents

The default source policy uses model-selected topics and holds sensitive results for review.
Project administrators and authorized curators can inspect the review queue in the console. They
can approve the proposed topics, replace them with topics they hold, or reject the document with an
auditable reason.

Only published knowledge is available to ordinary recall. A pending or rejected document can exist
in storage while returning no recall result.

## Query through MCP

Connect an MCP client using [Connect an MCP client](connect-mcp-client.md), then call the `recall`
tool with a question:

```json
{
  "query": "What is the deployment approval policy?",
  "top_k": 8
}
```

A successful result contains `found`, answer fragments, provenance, credibility, topic tags, and
temporal fields. The server can return `found: false` when nothing relevant is visible, when the
best score is below the configured threshold, or when matching content is outside the token's
topic scope. These cases deliberately share a non-disclosing shape.

## Remove local shell credentials

```bash
unset BRAIN_PAT BRAIN_URL BRAIN_PROJECT
```

For request and response details, see the [REST API reference](../reference/rest-api.md) and
[MCP reference](../reference/mcp.md).
