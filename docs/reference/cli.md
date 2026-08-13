<!-- diataxis: reference -->

# CLI reference

The `brain` command exposes local deployment, ingestion, knowledge-management, and administration operations. Command names and options below mirror the registered Typer application.

## Invocation

```text
brain [GLOBAL OPTIONS] COMMAND [COMMAND OPTIONS]
```

Running `brain` with no command prints help. Completion commands are not registered.

## Global options

| Option | Meaning |
|---|---|
| `--json` | Emit JSON instead of the command's human-readable result. It may appear before the command or on an executable command. |
| `--version` | Print the installed rsc-brain version and exit. This is a root option. |
| `--help` | Print context-sensitive help and exit. Click supplies this option for the root, groups, and commands. |

## Deployment and diagnostics commands

| Command | Purpose | Arguments and options |
|---|---|---|
| `brain init` | Apply migrations and create the first administrator. Repeated runs are idempotent. | `--admin-email TEXT`; `--admin-password TEXT`. When the password is absent, the generated credential is written to `first-admin-credential` under `RSC_BRAIN_INGEST__DATA_DIR`, default `data`, with mode `0600`. Output reports the file path but never the password. |
| `brain init-env` | Create `.env` if absent and generate any unset required secret. Idempotent: a value already set is never rotated, so re-running it cannot change the database password out from under a running database. | `--check` reports whether the required secrets are usable and changes nothing; exits non-zero when any is blank or a placeholder. |
| `brain doctor` | Detect host characteristics, recommend a hardware profile, and scan configuration for secrets. | No command-specific options. |
| `brain plan` | Print the install phases that apply would execute without changing the deployment. | No command-specific options. |
| `brain apply` | Execute the checkpointed install plan with per-phase rollback. | `--yes` suppresses confirmations for automation. |
| `brain verify` | Check that every model capability has a provider/model route, that PostgreSQL is reachable with AGE and pgvector, and that the schema is at migration head. | No command-specific options. This command does not contact model providers or run ingest-to-recall smoke work. |
| `brain migrate` | Apply database migrations to the current head revision. | No command-specific options. |
| `brain wait-for-schema` | Wait until the database schema reaches the current head revision. | `--timeout INTEGER`, default `300` seconds. |
| `brain preflight` | Report cross-project data that would block a migration. | No command-specific options. |
| `brain backup` | Write a snapshot directory containing a custom-format database dump, stored document blobs, and a manifest with sizes and SHA-256 digests. | Required `--output PATH` or `-o PATH`. |
| `brain restore` | Verify a snapshot, restore the database and stored blobs, apply migrations, and verify extensions and schema head. | Required `SNAPSHOT` path produced by `brain backup`. Snapshot verification happens before the target is changed. |
| `brain calibrate` | Report the calibration set and default relevance threshold. | No command-specific options. |
| `brain eval` | Report golden-set composition. | No command-specific options. A full evaluation requires an ingested corpus. |
| `brain usage` | Report daily token and call usage by model capability. | `--days INTEGER`, default `7`; optional `--project TEXT` limits the report to one project. |

## Ingestion and document commands

| Command | Purpose | Arguments and options |
|---|---|---|
| `brain ingest` | Ingest a file, directory, or glob into a project with deduplication and the approval gate. | Required `PATH` and `--project TEXT`; optional `--source TEXT`. |
| `brain status` | List per-document ingestion runs, phases, claim counts, and errors. | Required `--project TEXT`. |
| `brain docs` | Parent group for document-review commands. | A child command is required for an operation. |
| `brain docs review` | List documents awaiting approval and their proposed tags. | Required `--project TEXT`. |
| `brain docs approve` | Approve and publish a pending document. | Required `DOCUMENT_ID` and `--project TEXT`; repeatable `--tags TEXT` replaces proposed tags when supplied. |
| `brain docs reject` | Reject a pending document while retaining the file and an audit reason. | Required `DOCUMENT_ID`, `--project TEXT`, and `--reason TEXT`. |
| `brain sources` | Parent group for ingestion-source commands. | A child command is required for an operation. |
| `brain sources list` | List a project's sources and categorization policies. | Required `--project TEXT`. |
| `brain sources create` | Create an ingestion source. | Required `NAME` and `--project TEXT`; `--type TEXT`, default `folder`; `--policy TEXT`, default `llm`; repeatable `--tag TEXT`; `--review-if-sensitive`/`--no-review`, default enabled. Supported type values are `folder`, `api`, and `connector`; supported policies are `manual`, `source_tags`, `llm`, and `llm_review`. |

## Project, identity, and topic commands

| Command | Purpose | Arguments and options |
|---|---|---|
| `brain projects` | Parent group for project commands. | A child command is required for an operation. |
| `brain projects list` | List projects. | No command-specific options. |
| `brain projects create` | Create a project. | Required `SLUG` and `--name TEXT`. |
| `brain projects delete` | Delete a project through the all-store erasure path. | Required `SLUG`; `--yes` confirms irreversible deletion. |
| `brain users` | Parent group for user and invitation commands. | A child command is required for an operation. |
| `brain users invite` | Create an invitation credential. | Required `EMAIL`; `--role TEXT`, default `member`, accepts `owner`, `admin`, or `member`. |
| `brain users accept` | Consume an invitation and set the user's password. | Required `TOKEN` and `--password TEXT`. |
| `brain users deactivate` | Disable a user and revoke that user's credentials. | Required `USER_ID`. |
| `brain topics` | Parent group for topic commands. | A child command is required for an operation. |
| `brain topics create` | Create a topic. | Required `--project-id TEXT`, `SLUG`, and `--name TEXT`; `--sensitivity INTEGER`, default `0`. Values of `3` or greater are restrictive. |

## People, gaps, and hunts

| Command | Purpose | Arguments and options |
|---|---|---|
| `brain persons` | Parent group for the hunting person directory. | A child command is required for an operation. |
| `brain persons list` | List people in a project directory. | Required `--project TEXT`. |
| `brain persons add` | Add a person and routing metadata. | Required `NAME` and `--project TEXT`; optional comma-separated `--topics TEXT`, `--email TEXT`, `--slack TEXT`, `--quiet-start TEXT`, `--quiet-end TEXT`, and `--language TEXT`. Quiet-hour values use `HH:MM` UTC. |
| `brain persons update` | Replace selected routing fields for a person. | Required `PERSON_ID` and `--project TEXT`; optional comma-separated `--topics TEXT`, `--email TEXT`, `--slack TEXT`, `--quiet-start TEXT`, `--quiet-end TEXT`, and `--language TEXT`. |
| `brain persons remove` | Remove a person from a project directory. | Required `PERSON_ID` and `--project TEXT`. |
| `brain gaps` | Parent group for knowledge-gap commands. | A child command is required for an operation. |
| `brain gaps list` | List human-driven knowledge gaps. | Required `--project TEXT`; `--agents` selects the separate agent-gap view. |
| `brain gaps promote` | Promote an agent gap to a human hunt. | Required `GAP_ID` and `--project TEXT`. Agent gaps are not promoted automatically. |
| `brain hunt` | Parent group for opening a manual hunt. | A child command is required for an operation. |
| `brain hunt ask` | Route a manual question by topic ownership, quiet hours, and anti-spam state. | Required `QUESTION` and `--project TEXT`; optional comma-separated `--topics TEXT`. |
| `brain hunts` | Parent group for hunt inspection. | A child command is required for an operation. |
| `brain hunts list` | List a project's hunts, newest first. | Required `--project TEXT`; `--open` limits the result to unresolved hunts. |
| `brain hunts show` | Show one hunt's lifecycle state. | Required `HUNT_ID` and `--project TEXT`. |

## Knowledge, review, and ontology commands

| Command | Purpose | Arguments and options |
|---|---|---|
| `brain corrections` | Parent group for correction history. | A child command is required for an operation. |
| `brain corrections list` | List a project's corrections, newest first. | Required `--project TEXT`. |
| `brain corrections revert` | Revert a correction by creating an audited restoring entry. | Required `CORRECTION_ID` and `--project TEXT`. |
| `brain entities` | Parent group for entity deduplication and alias merges. | A child command is required for an operation. |
| `brain entities merge` | Propose alias merges, auto-apply high-confidence proposals, and queue the remainder. | Required `--project TEXT`. |
| `brain entities merges` | Parent group for the alias-merge review queue. | A child command is required for an operation. |
| `brain entities merges list` | List merge proposals, newest first. | Required `--project TEXT`; optional `--status TEXT`. |
| `brain entities merges confirm` | Merge a duplicate entity into its canonical entity. | Required `PROPOSAL_ID` and `--project TEXT`. |
| `brain entities merges reject` | Close a merge proposal without merging entities. | Required `PROPOSAL_ID` and `--project TEXT`. |
| `brain skills` | Parent group for reusable skill records. | A child command is required for an operation. |
| `brain skills list` | List a project's skills. | Required `--project TEXT`; optional `--state TEXT`. |
| `brain skills show` | Print a skill's complete Markdown. | Required `SLUG` and `--project TEXT`. |
| `brain skills create` | Create a skill from a Markdown file containing frontmatter and a body. | Required `FILE` and `--project TEXT`. |
| `brain skills edit` | Replace a skill from a Markdown file, clear its stale flag, and increment its version. | Required `FILE` and `--project TEXT`. |
| `brain skills archive` | Archive a skill so it is no longer exposed through MCP. | Required `SLUG` and `--project TEXT`. |
| `brain ontology` | Parent group for optional ontology anchoring. | A child command is required for an operation. |
| `brain ontology list` | List a project's stored ontologies. | Required `--project TEXT`. |
| `brain ontology validate` | Parse a local ontology file without storing it. | Required `FILE`; optional `--format TEXT`. Supported format labels are `owl`, `rdf`, `skos`, and `turtle`; the format is inferred when omitted. |
| `brain ontology add` | Validate and store a versioned ontology; a newer version with the same name becomes active. | Required `FILE` and `--project TEXT`; optional `--name TEXT`, `--format TEXT`, and `--uri-base TEXT`. |
| `brain ontology coverage` | Report the anchored-entity percentage and leading unanchored names. | Required `--project TEXT`; `--top INTEGER`, default `10`. |

## Audit, export, deletion, and demo commands

| Command | Purpose | Arguments and options |
|---|---|---|
| `brain audit` | Query a project's audit log or write the filtered result as CSV. | Required `--project-id TEXT`; optional `--action TEXT`, `--tool TEXT`, `--principal-type TEXT`, `--principal-id TEXT`, `--denied`/`--not-denied`, `--since TEXT`, `--until TEXT`, `--limit INTEGER` with default `100`, and `--export PATH`. Dates accept a date or ISO timestamp. |
| `brain export` | Export project claims and skills as an Open Knowledge Foundation bundle, with optional RDF/Turtle graph data. | Required `--project TEXT`; `--okf`/`--no-okf`, default enabled; `--rdf`; optional `--output PATH`. |
| `brain forget` | Hard-delete project data and tombstone associated graph nodes. | Required `--project TEXT`; select `--document TEXT`, `--entity TEXT`, or `--whole-project`. A whole-project erasure also requires `--yes` and `--confirm-slug TEXT`. |
| `brain demo` | Seed a fictional project, taxonomy, person, processed document, chunk, and claim. | `--reset` removes the seeded company. The seeded chunk has no embedding, so this command alone does not create a recallable vector result. |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The operation completed, or help/version output was requested. |
| `1` | A registered operation failed at runtime, such as a database, validation-after-load, verification, or restore failure. |
| `2` | Command-line usage or input validation failed, or the selected command is registered but unsupported. |

Click can print a usage diagnostic before exit code `2`. With `--json`, implemented commands emit their command-specific object; unsupported commands emit an object with `status` set to `not_implemented` and the command name.

## Unsupported commands

The following names are registered so automation can detect them, but they do not perform an operation:

| Command | Behavior |
|---|---|
| `brain up` | Prints an unsupported-command diagnostic and exits with code `2`. |
| `brain down` | Prints an unsupported-command diagnostic and exits with code `2`. |

No other unregistered command is accepted. Click reports an unknown command and exits with code `2`.
