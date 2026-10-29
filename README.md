# RSC Brain

A self-hosted knowledge server for AI agents and the people who work with them.

Agents write down what they do in a **journal**. People approve what becomes the **wiki**: typed pages with typed links, each citing its sources. Any agent can search it, over MCP or HTTP, before it works.

> Status: early development. Not ready for use.

## License

MIT. See [LICENSE](LICENSE).

## Development

Requirements: Node 25 and, for the full test suite, PostgreSQL 17 or newer.

```sh
npm install
npm run verify      # lint, types, tests, audit
```

`scripts/verify.sh` runs the tests against a real PostgreSQL: the server in `RSC_BRAIN_PG_URL`, or,
when the PostgreSQL binaries are installed, a throwaway local cluster in `.pg-test/` (port 55432)
that it starts for you (`npm run pg:stop` stops it). Without either, the PostgreSQL tests are
skipped, as in CI.
