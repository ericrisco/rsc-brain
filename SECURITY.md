# Security Policy

## Report a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's
[private vulnerability reporting](https://github.com/ericrisco/rsc-brain/security/advisories/new)
for this repository. Include the affected version or commit, impact, reproduction conditions, and
any known mitigation. The project aims to acknowledge a report within five working days and agrees
on a disclosure timeline before publishing details.

## Supported versions

rsc-brain is pre-1.0. Security fixes target `main` and the next release; older `0.x` tags do not
receive backports. Confirm the running package with `brain --version` before reporting or applying a
fix. The current documented release is `0.14.0`.

## Security boundaries

- A credential resolves one principal and project scope. Project content also requires membership,
  a named capability, and any relevant topic authority.
- Topic filtering occurs before content, counts, order, pages, graph neighbours, exports, or model
  context become observable.
- Source documents and retrieved fragments are untrusted data. They cannot select tools,
  permissions, credentials, destinations, or executable actions.
- Configuration owns model routing. Secrets come from environment variables, Docker/Kubernetes
  secrets, or an equivalent secrets backend; committed examples contain field names and placeholders
  only.
- Route validators bound documented fields, arrays, pages, exports, ontology input, and time
  windows. There is no global HTTP body limit in 0.14.0, and document upload does not enforce the
  declared `limits.upload_bytes`; place a body ceiling at the trusted edge.
- Backups include database state and stored source blobs. Restore validates the snapshot before
  database mutation, but blob copy does not remove files absent from the snapshot; restore into a
  new or empty data directory.

See [Security and tenancy](docs/explanation/security-and-tenancy.md) for the design and
[Permissions reference](docs/reference/permissions.md) for the authorization matrix.

## Automated gates

The repository's workflows currently require:

| Gate | Workflow evidence |
| --- | --- |
| Lint, formatting, and Python SAST | Ruff, including the `S` security rules |
| Strict types | mypy over source, tests, and eval code |
| Unit and real-data-service tests | pytest; the integration job builds Postgres 16 + AGE + pgvector and enforces at least 70% coverage over the full suite |
| Secret scanning | gitleaks over the working tree and Git history; current fixtures are line-local and historical exceptions are exact fingerprints |
| Dependency scanning | native `pip-audit`, full-lock `npm audit --audit-level=high`, and fail-closed OSV over `uv.lock` plus `apps/admin/package-lock.json` |
| License policy | AGPL compatibility audit |
| Console contract | OpenAPI export and generated TypeScript drift checks, lint, types, and production build |
| Edge routing | live Caddy traversal of the supported route matrix |
| Kubernetes packaging | Compose/chart parity, Helm lint, and kubeconform on default and production-like renders |
| Release artifacts | SPDX SBOM from Syft and a Grype CVE scan |

Workflow actions and downloaded scanner binaries are pinned or checksum-verified, and workflow
tokens default to read-only permissions. The manually dispatched release workflow is a
non-publishing rehearsal: it reuses all CI gates and builds every first-party image without registry
login, package/signing scopes, or a release mutation. A green structural/render check is not proof that a live
TLS, OAuth, model-provider, restore, or Kubernetes environment worked; those checks require the
corresponding infrastructure.

## Secret handling

- Never commit `.env`, generated credentials, tokens, database dumps, or private source documents.
- Do not place API keys or the database DSN in `config.yaml` or `config.example.yaml`.
- Give production secrets through environment variables, Compose/PaaS secret injection, or a
  Kubernetes Secret. Restrict local secret files to their owner.
- `brain init` does not print a generated first-admin password. Prefer supplying one explicitly; if
  the CLI generates it, retrieve it from the owner-only file path reported by the command, then
  remove that file after storing the credential safely.

The data image also refuses blank, known-placeholder, or short PostgreSQL passwords before the
server starts. See the [data-service guide](docker/README.md).
