# Connect an MCP client
<!-- diataxis: how-to -->

rsc-brain serves MCP over streamable HTTP at `/mcp`. Use a project-scoped personal access token as
the bearer credential.

## Create a personal access token

1. Sign in to the administration console.
2. Select the project the client may access.
3. Open **Connections** and create a personal access token.
4. Copy the `ck_…` value when it is displayed. The plaintext value cannot be listed again.

The token fixes the project and current topic authority. A project parameter in a tool call cannot
change that scope. Revoking the token, deactivating its principal, or removing a topic grant affects
the next authenticated request.

## Configure the client

Enter these values in a client that supports streamable HTTP MCP with custom headers:

| Client field | Value |
|---|---|
| Transport | Streamable HTTP |
| Server URL | `https://brain.example.com/mcp` |
| Header name | `Authorization` |
| Header value | `Bearer ck_your_token` |

Use HTTPS outside a loopback development environment. Keep the token in the client's secret store,
not in a version-controlled configuration file.

Client configuration formats differ. If a client accepts a JSON server entry, map its URL and
header fields to this shape:

```json
{
  "url": "https://brain.example.com/mcp",
  "headers": {
    "Authorization": "Bearer ck_your_token"
  }
}
```

Treat this as a field mapping, not a universal filename or schema. Follow the client's instructions
for adding a remote streamable HTTP server.

## Confirm the connection

Refresh the client's tool list. The server exposes these eight base tools:

- `recall`
- `timeline`
- `list_skills`
- `run_skill`
- `get_document`
- `report_feedback`
- `submit_knowledge`
- `correct_knowledge`

It also exposes one `skill_<slug>` tool for every active skill visible to the bearer. This part of
the list is authorization-aware and read-through, so two credentials can see different tools and a
skill or permission change appears on the next refresh.

Call `list_skills` with no arguments or call `recall` with a known question. An empty result is a
valid permission-filtered response; it does not prove that the connection failed.

## Diagnose authentication failures

- `AUTH_INVALID` covers a missing, malformed, revoked, expired, or otherwise unresolved credential.
  The server does not reveal which case occurred.
- A client that cannot attach a custom bearer header cannot use this PAT procedure.
- The server publishes OAuth authorization-server metadata, but it does not publish MCP protected-
  resource metadata in release 0.13.0. A client that requires automatic OAuth discovery may not be
  compatible with the current endpoint.
- A reverse proxy must preserve the `Authorization` header and route `/mcp` to the API service.
- `RATE_LIMITED` includes a `retry_after` value in seconds.

See the [MCP reference](../reference/mcp.md) for tool schemas, quotas, delegation, errors, and the
untrusted-data contract.
