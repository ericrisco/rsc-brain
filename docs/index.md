# rsc-brain documentation

This is the public documentation map for release 0.13.0. Choose a page by the outcome you need or
the role you have.

Return to the [project overview](../README.md).

## I am evaluating or starting rsc-brain

| Goal | Audience | Page |
|---|---|---|
| Start the API and prove that its local dependencies are ready | First-time user | [Start a local rsc-brain API](tutorials/getting-started.md) |
| Understand the processes, stores, and network boundaries | Technical evaluator, architect | [Architecture](explanation/architecture.md) |
| Understand how documents become recallable knowledge | Knowledge owner, evaluator | [Knowledge lifecycle](explanation/knowledge-lifecycle.md) |
| Understand project isolation and topic permissions | Security reviewer, administrator | [Security and tenancy](explanation/security-and-tenancy.md) |

## I want to use the knowledge service

| Goal | Audience | Page |
|---|---|---|
| Ingest a document and query the resulting knowledge | Project administrator | [Ingest and query](how-to/ingest-and-query.md) |
| Connect an MCP client | AI-tool integrator | [Connect an MCP client](how-to/connect-mcp-client.md) |
| Look up MCP tools, errors, quotas, and provenance | AI-tool integrator | [MCP reference](reference/mcp.md) |
| Look up REST operations and response contracts | API integrator | [REST API reference](reference/rest-api.md) |
| Look up roles, capabilities, and topic rules | Administrator, security reviewer | [Permissions reference](reference/permissions.md) |

## I operate an installation

| Goal | Audience | Page |
|---|---|---|
| Understand the shipped deployment topology | Self-hosting operator | [Deployment topology](../deploy/README.md) |
| Configure the application and model routes | Self-hosting operator | [Configuration reference](reference/configuration.md) |
| Look up commands, options, and exit codes | Operator, automation author | [CLI reference](reference/cli.md) |
| Back up or restore data | Database operator | [Back up and restore](how-to/backup-and-restore.md) |
| Upgrade an installation | Release operator | [Upgrade](how-to/upgrade.md) |
| Diagnose a failed installation or request | Operator | [Troubleshooting](how-to/troubleshooting.md) |
| Inspect the development database image and its guards | Developer, operator | [Data-service notes](../docker/README.md) |

## I contribute to the project

| Goal | Audience | Page |
|---|---|---|
| Set up a development environment and submit a change | Contributor | [Contributing guide](../CONTRIBUTING.md) |
| Navigate the source tree and focused checks | Contributor, coding agent | [Development runbook](AGENTS.md) |
| Apply the compact coding-agent contract | Coding agent | [Coding-agent guidance](CLAUDE.md) |
| Understand the stable internal service contracts | Contributor | [Interface freeze](interface-freeze.md) |
| Work on the administration console | Front-end contributor | [Admin console notes](../apps/admin/README.md) |
| Inspect the synthetic quality corpus and metrics | Model or retrieval contributor | [Evaluation corpus](../evals/README.md) |
| Read recorded release notes through 0.13.0 | User, contributor | [Changelog](../CHANGELOG.md) |
| Report a vulnerability | Security researcher | [Security policy](../SECURITY.md) |

The project is licensed under [AGPL-3.0-or-later](../LICENSE).
