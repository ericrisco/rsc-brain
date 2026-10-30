// Spec B5 «El kit de conexión», CA2, CA15, CA16: what the server gives to connect each agent
// (GET /v1/connect), the local bridge for agents that only speak MCP over stdio (`rsc-brain bridge`), and
// the optional reminder of Claude Code (`rsc-brain hook session-start` / `rsc-brain hook stop`).
import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { MODERN } from '../../src/mcp/server.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>
type Blocks = { blocks: Json[] }
const CLI = new URL('../../src/cli/main.ts', import.meta.url).pathname
const AGENTS = ['claude-code', 'codex', 'opencode', 'cursor', 'other']
// What the config files write literally, for the agent to expand from the environment.
const CLAUDE_HEADER = 'Bearer $' + '{RSC_BRAIN_TOKEN}'
const CURSOR_HEADER = 'Bearer $' + '{env:RSC_BRAIN_TOKEN}'

// A port nothing listens on: the server is down.
const deadPort = () =>
  new Promise<number>((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })

const envOf = (extra: Record<string, string | undefined> = {}) => {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...process.env, ...extra })) if (v !== undefined) env[k] = v
  return env
}

// Runs the command to the end with `stdin`, as an agent runs a hook.
function run(
  args: string[],
  o: { stdin?: string; env?: Record<string, string | undefined> } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: envOf(o.env), cwd: tmpdir() })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => {
      stdout += d
    })
    p.stderr.on('data', (d) => {
      stderr += d
    })
    p.on('close', (code) => resolve({ code, stdout, stderr }))
    p.stdin.end(o.stdin ?? '')
  })
}

// A bridge driven over stdio the way a local agent drives it: one JSON message per line.
class Bridge {
  p: ChildProcessWithoutNullStreams
  lines: Json[] = []
  stderr = ''
  raw = ''
  private waiters: Array<() => void> = []
  exited: Promise<number | null>
  constructor(args: string[], env: Record<string, string | undefined>) {
    this.p = spawn(process.execPath, [CLI, 'bridge', ...args], { env: envOf(env), cwd: tmpdir() })
    this.exited = new Promise((r) => this.p.on('exit', (code) => r(code)))
    let buf = ''
    this.p.stdout.on('data', (d) => {
      this.raw += d
      buf += d
      let i = buf.indexOf('\n')
      while (i >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.trim()) this.lines.push(JSON.parse(line))
        for (const w of this.waiters.splice(0)) w()
        i = buf.indexOf('\n')
      }
    })
    this.p.stderr.on('data', (d) => {
      this.stderr += d
    })
  }
  send(msg: unknown) {
    this.p.stdin.write(`${typeof msg === 'string' ? msg : JSON.stringify(msg)}\n`)
  }
  async reply(id: unknown, ms = 15_000): Promise<Json> {
    const end = Date.now() + ms
    for (;;) {
      const found = this.lines.find((l) => l.id === id)
      if (found) return found
      if (Date.now() > end) throw new Error(`no reply to ${String(id)}; stderr: ${this.stderr}`)
      await new Promise<void>((r) => {
        this.waiters.push(r)
        setTimeout(r, 100)
      })
    }
  }
  async request(id: unknown, method: string, params: Json = {}): Promise<Json> {
    this.send({ jsonrpc: '2.0', id, method, params })
    return this.reply(id)
  }
  async close(): Promise<number | null> {
    this.p.stdin.end()
    return this.exited
  }
}

describe('the connection kit', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let stateDir: string
  let mcpUrl: string
  let n = 0

  // A call straight to /mcp, as a remote agent makes it (legacy era unless `modern`).
  async function direct(key: string, method: string, params: Json = {}, modern = false): Promise<Json> {
    n += 1
    const res = await fetch(`${w.base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        ...(modern
          ? {
              'mcp-protocol-version': MODERN,
              'mcp-method': method,
              ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
            }
          : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `d${n}`,
        method,
        params: modern ? { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } } : params,
      }),
    })
    return (await res.json()) as Json
  }

  const agentsOf = (body: Json) => body.agents as Json[]
  const tokenBlocks = (a: Json | undefined) => ((a as Json).token as Blocks).blocks
  const reminderBlocks = (a: Json | undefined) => ((a as Json).reminder as Blocks).blocks

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    mcpUrl = `${w.base}/mcp`
    stateDir = await mkdtemp(join(tmpdir(), 'rsc-brain-kit-'))
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'alpha', purpose: 'The channel.' })
    await w.call(eric.key, 'POST', '/v1/brains/alpha/entries', {
      type: 'decision',
      title: 'Retention first',
      content: 'We measure retention before anything else.',
    })
  })
  after(async () => {
    await rm(stateDir, { recursive: true, force: true })
    await w.close()
  })

  describe('GET /v1/connect', () => {
    it('needs a key', async () => {
      const r = await w.call(null, 'GET', '/v1/connect')
      assert.equal(r.status, 401)
    })

    it('gives every agent its ways to connect, the check phrase, and never a secret', async () => {
      const r = await w.call(eric.key, 'GET', '/v1/connect')
      assert.equal(r.status, 200, r.text)
      assert.equal(r.body.mcpUrl, 'http://localhost/mcp')
      assert.equal(r.body.tokenEnv, 'RSC_BRAIN_TOKEN')
      assert.equal(typeof r.body.tokenPlaceholder, 'string')
      const agents = agentsOf(r.body)
      assert.deepEqual(
        agents.map((a) => a.id),
        AGENTS,
      )
      for (const a of agents) {
        assert.equal(typeof a.name, 'string')
        assert.match(String(a.check), /what does this brain know about X\?/i)
        const blocks = tokenBlocks(a)
        assert.ok(blocks.length > 0, `${a.id}: a token block`)
        // The web fills the placeholder once (B6); the server never puts a secret in a block.
        assert.ok(
          blocks.some((b) => String(b.text).includes(String(r.body.tokenPlaceholder))),
          `${a.id}: some block carries the placeholder`,
        )
        for (const b of blocks) assert.ok(b.title && b.where && b.format && b.text, `${a.id}: block fields`)
      }
      assert.ok(!r.text.includes(eric.key), 'the caller key is never in the kit')
      // Every agent studied supports the standard sign-in with only the address, and gets a reminder.
      for (const a of agents.filter((x) => x.id !== 'other')) assert.ok(a.signIn, `${a.id}: sign-in`)
      for (const a of agents) assert.ok(a.reminder, `${a.id}: reminder`)
    })

    it('Claude Code: sign-in with the address, a .mcp.json with the token from the environment, and hooks', async () => {
      const r = await w.call(eric.key, 'GET', '/v1/connect?agent=claude-code')
      const [a] = agentsOf(r.body)
      const signIn = (a as Json).signIn as Blocks
      assert.ok(
        signIn.blocks.some((b) =>
          String(b.text).includes('claude mcp add --transport http rsc-brain http://localhost/mcp'),
        ),
      )
      const file = tokenBlocks(a).find((b) => b.where === '.mcp.json')
      const cfg = JSON.parse(String(file?.text)) as { mcpServers: Record<string, Json> }
      assert.deepEqual(cfg.mcpServers['rsc-brain'], {
        type: 'http',
        url: 'http://localhost/mcp',
        headers: { Authorization: CLAUDE_HEADER },
      })
      assert.equal(((a as Json).reminder as Json).kind, 'hooks')
      const hooks = JSON.parse(String(reminderBlocks(a)[0]?.text)).hooks as Record<
        string,
        Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>
      >
      assert.equal(hooks.SessionStart?.[0]?.hooks[0]?.type, 'command')
      assert.equal(
        hooks.SessionStart?.[0]?.hooks[0]?.command,
        'rsc-brain hook session-start --url http://localhost/mcp',
      )
      assert.equal(hooks.Stop?.[0]?.hooks[0]?.command, 'rsc-brain hook stop --url http://localhost/mcp')
      assert.equal(hooks.Stop?.[0]?.matcher, undefined, 'Stop takes no matcher')
    })

    it('OpenCode, Cursor and other: their own config shapes; other uses the bridge', async () => {
      const r = await w.call(eric.key, 'GET', '/v1/connect')
      const by = Object.fromEntries(agentsOf(r.body).map((a) => [a.id, a]))
      const blockOf = (id: string, where: string) => {
        const b = tokenBlocks(by[id]).find((x) => x.where === where)
        assert.ok(b, `${id}: a block for ${where}`)
        return JSON.parse(String(b.text))
      }
      assert.deepEqual(blockOf('opencode', 'opencode.json').mcp['rsc-brain'], {
        type: 'remote',
        url: 'http://localhost/mcp',
        oauth: false,
        headers: { Authorization: 'Bearer {env:RSC_BRAIN_TOKEN}' },
      })
      assert.deepEqual(blockOf('cursor', '.cursor/mcp.json').mcpServers['rsc-brain'], {
        url: 'http://localhost/mcp',
        headers: { Authorization: CURSOR_HEADER },
      })
      assert.deepEqual(blockOf('other', 'mcpServers').mcpServers['rsc-brain'], {
        command: 'rsc-brain',
        args: ['bridge', '--url', 'http://localhost/mcp', '--token-file', '~/.config/rsc-brain/token'],
      })
      // Agents without hooks get the invocable prompt and the text for their instructions file.
      const rem = by.codex?.reminder as { kind: string; prompt: string; blocks: Json[] }
      assert.equal(rem.kind, 'instructions')
      assert.equal(rem.prompt, 'close_session')
      assert.match(String(rem.blocks[0]?.text), /mem_session_summary/)
    })

    it('?agent= picks one; an unknown agent is refused with the list', async () => {
      const one = await w.call(eric.key, 'GET', '/v1/connect?agent=codex')
      assert.deepEqual(
        agentsOf(one.body).map((a) => a.id),
        ['codex'],
      )
      const bad = await w.call(eric.key, 'GET', '/v1/connect?agent=nope')
      assert.equal(bad.status, 400)
      assert.match(bad.body.error?.howToProceed ?? '', /claude-code/)
    })

    it('?brain= names the brain in the check and in the start hook; a brain the key cannot see is not found', async () => {
      const r = await w.call(eric.key, 'GET', '/v1/connect?brain=alpha&agent=claude-code')
      const [a] = agentsOf(r.body)
      assert.match(String((a as Json).check), /"alpha"/)
      const hooks = JSON.parse(String(reminderBlocks(a)[0]?.text)).hooks
      assert.match(hooks.SessionStart[0].hooks[0].command, /--brain alpha$/)
      const none = await w.call(eric.key, 'GET', '/v1/connect?brain=nowhere')
      assert.equal(none.status, 404)
    })

    it('CA2: the Codex token block works as Codex reads it: mem_save and mem_search over remote HTTP', async () => {
      const r = await w.call(eric.key, 'GET', '/v1/connect?agent=codex')
      const [a] = agentsOf(r.body)
      const toml = String(tokenBlocks(a).find((b) => b.where === '~/.codex/config.toml')?.text)
      assert.match(toml, /^\[mcp_servers\.rsc-brain\]$/m)
      assert.equal(/^url = "(.+)"$/m.exec(toml)?.[1], 'http://localhost/mcp')
      assert.equal(/^bearer_token_env_var = "(.+)"$/m.exec(toml)?.[1], 'RSC_BRAIN_TOKEN')
      // Codex sends the value of that variable as a bearer token to the url; here, to the test server.
      const token = await w.token(eric.id, { perm: 'write' })
      const init = await direct(token, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'codex', version: '1' },
      })
      assert.ok((init.result as Json).instructions)
      const saved = await direct(token, 'tools/call', {
        name: 'mem_save',
        arguments: {
          brain: 'alpha',
          type: 'fact',
          title: 'Codex was here',
          content: 'Saved through the kit.',
        },
      })
      assert.equal((saved.result as Json).isError, false, JSON.stringify(saved))
      const found = await direct(token, 'tools/call', {
        name: 'mem_search',
        arguments: { q: 'Codex was here' },
      })
      assert.match(JSON.stringify(found.result), /Codex was here/)
    })
  })

  describe('rsc-brain bridge (CA15)', () => {
    it('a legacy client over stdio gets what a remote client gets: initialize, tools/list, mem_save, mem_search', async () => {
      const token = await w.token(eric.id)
      const b = new Bridge(['--url', mcpUrl], { RSC_BRAIN_TOKEN: token })
      const hello = {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'local', version: '1' },
      }
      try {
        const init = await b.request(1, 'initialize', hello)
        assert.deepEqual(init.result, (await direct(token, 'initialize', hello)).result)
        // A notification gets no answer.
        b.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        const list = await b.request('two', 'tools/list')
        assert.deepEqual(list.result, (await direct(token, 'tools/list')).result)
        const saved = await b.request(3, 'tools/call', {
          name: 'mem_save',
          arguments: { brain: 'alpha', type: 'fact', title: 'Bridged entry', content: 'Through stdio.' },
        })
        assert.equal((saved.result as Json).isError, false, JSON.stringify(saved))
        const search = { name: 'mem_search', arguments: { q: 'Bridged entry' } }
        const viaBridge = await b.request(4, 'tools/call', search)
        const viaRemote = await direct(token, 'tools/call', search)
        assert.match(JSON.stringify(viaBridge.result), /Bridged entry/)
        assert.deepEqual(viaBridge.result, viaRemote.result)
        assert.equal(b.lines.length, 4, 'one line per request, none for the notification')
        assert.equal(await b.close(), 0)
        assert.ok(!b.raw.includes(token) && !b.stderr.includes(token), 'the token is never printed')
      } finally {
        b.p.kill()
      }
    })

    it('a modern client: the bridge adds the headers the server checks, encoding a name that needs it', async () => {
      const token = await w.token(eric.id)
      const b = new Bridge(['--url', mcpUrl], { RSC_BRAIN_TOKEN: token })
      const meta = { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } }
      try {
        const disc = await b.request(1, 'server/discover', meta)
        assert.equal((disc.result as Json).resultType, 'complete')
        const list = await b.request(2, 'tools/list', meta)
        assert.deepEqual(list.result, (await direct(token, 'tools/list', {}, true)).result)
        const search = await b.request(3, 'tools/call', {
          ...meta,
          name: 'mem_search',
          arguments: { q: 'retention' },
        })
        assert.match(JSON.stringify(search.result), /Retention first/)
        // A name outside plain ASCII travels base64-encoded; the server decodes it and finds no such tool
        // (not a header mismatch).
        const odd = await b.request(4, 'tools/call', { ...meta, name: 'mem_sävé', arguments: {} })
        assert.equal((odd.error as Json).code, -32602, JSON.stringify(odd))
        await b.close()
      } finally {
        b.p.kill()
      }
    })

    it('errors stay JSON-RPC: a bad line, a refused token, and a server that is down, without crashing', async () => {
      const port = await deadPort()
      const down = new Bridge(['--url', `http://127.0.0.1:${port}/mcp`], { RSC_BRAIN_TOKEN: 'x' })
      try {
        const e1 = await down.request(1, 'tools/list')
        const err = e1.error as { code: number; message: string }
        assert.equal(err.code, -32000)
        assert.match(err.message, /cannot reach/i)
        assert.match(err.message, /How to proceed/)
        // Still alive: the next request is answered too.
        const e2 = await down.request(2, 'ping')
        assert.equal((e2.error as Json).code, -32000)
        down.send('{ not json')
        const parse = await down.reply(null)
        assert.equal((parse.error as Json).code, -32700)
        assert.equal(await down.close(), 0)
      } finally {
        down.p.kill()
      }
      const refused = new Bridge(['--url', mcpUrl], { RSC_BRAIN_TOKEN: 'rscb_not_a_real_token' })
      try {
        const r = await refused.request('a', 'tools/list')
        assert.equal(r.id, 'a', 'the error carries the request id')
        assert.equal((r.error as Json).code, -32001)
        await refused.close()
      } finally {
        refused.p.kill()
      }
    })

    it('needs a token from the environment or a file, never from the command line; refuses plain http to another host', async () => {
      const none = await run(['bridge', '--url', mcpUrl], {
        env: { RSC_BRAIN_TOKEN: undefined, HOME: stateDir },
      })
      assert.equal(none.code, 2)
      assert.match(none.stderr, /RSC_BRAIN_TOKEN/)
      const flag = await run(['bridge', '--url', mcpUrl, '--token', 'abc'], { env: { RSC_BRAIN_TOKEN: 'x' } })
      assert.equal(flag.code, 2)
      const plain = await run(['bridge', '--url', 'http://brain.example.com/mcp'], {
        env: { RSC_BRAIN_TOKEN: 'x' },
      })
      assert.equal(plain.code, 2)
      assert.match(plain.stderr, /https/)
    })

    it('a token with a line break inside is refused and never printed', async () => {
      const r = await run(['bridge', '--url', mcpUrl], {
        env: { RSC_BRAIN_TOKEN: 'rsc_live_SECRETPART1\nrsc_live_SECRETPART2' },
      })
      assert.equal(r.code, 2)
      assert.match(r.stderr, /line break/)
      assert.ok(!`${r.stdout}${r.stderr}`.includes('SECRETPART'), 'the token was printed')
    })

    it('against a stub server: a large answer survives the end of input; the agreed version travels; a bad method is answered', async () => {
      const seen: Array<{ method: string; version: string | undefined }> = []
      const big = 'x'.repeat(200_000)
      const server = http.createServer((req, res) => {
        let body = ''
        req.on('data', (c) => {
          body += c
        })
        req.on('end', () => {
          const m = JSON.parse(body) as { id: unknown; method: string }
          seen.push({ method: m.method, version: req.headers['mcp-protocol-version'] as string | undefined })
          const result =
            m.method === 'initialize'
              ? {
                  protocolVersion: '2025-11-25',
                  capabilities: {},
                  serverInfo: { name: 'stub', version: '1' },
                }
              : { content: [{ type: 'text', text: big }] }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }))
        })
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      const { port } = server.address() as { port: number }
      try {
        const lines = [
          { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
          { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mem_get', arguments: {} } },
          { jsonrpc: '2.0', id: 3, method: 42 },
        ]
          .map((x) => JSON.stringify(x))
          .join('\n')
        const r = await run(['bridge', '--url', `http://127.0.0.1:${port}/mcp`], {
          stdin: `${lines}\n`,
          env: { RSC_BRAIN_TOKEN: 'stub-token' },
        })
        const out = r.stdout
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as { id: number; result?: Json; error?: { code: number } })
        const answer = out.find((x) => x.id === 2)
        assert.equal(
          ((answer?.result?.content as Array<{ text: string }>)[0] as { text: string }).text.length,
          200_000,
        )
        assert.equal(out.find((x) => x.id === 3)?.error?.code, -32600)
        // A client that waits for initialize, as clients do: later requests carry the agreed version.
        seen.length = 0
        const b = new Bridge(['--url', `http://127.0.0.1:${port}/mcp`], { RSC_BRAIN_TOKEN: 'stub-token' })
        try {
          await b.request(1, 'initialize', { protocolVersion: '2025-11-25' })
          await b.request(2, 'tools/call', { name: 'mem_get', arguments: {} })
          assert.deepEqual(
            seen.map((x) => [x.method, x.version]),
            [
              ['initialize', undefined],
              ['tools/call', '2025-11-25'],
            ],
          )
          await b.close()
        } finally {
          b.p.kill()
        }
      } finally {
        server.close()
      }
    })

    it('reads the token from --token-file', async () => {
      const token = await w.token(eric.id)
      const file = join(stateDir, 'token')
      await writeFile(file, `${token}\n`, { mode: 0o600 })
      const b = new Bridge(['--url', mcpUrl, '--token-file', file], { RSC_BRAIN_TOKEN: undefined })
      try {
        const r = await b.request(1, 'tools/list')
        assert.ok(((r.result as Json).tools as Json[]).length > 0, JSON.stringify(r))
        await b.close()
      } finally {
        b.p.kill()
      }
    })
  })

  describe('the Claude Code reminder (CA16)', () => {
    let repo: string
    const stop = (env: Record<string, string | undefined>, input: Json, url = mcpUrl) =>
      run(['hook', 'stop', '--url', url], {
        stdin: JSON.stringify({ hook_event_name: 'Stop', cwd: tmpdir(), ...input }),
        env: { RSC_BRAIN_STATE_DIR: stateDir, ...env },
      })
    const start = (
      env: Record<string, string | undefined>,
      cwd: string,
      extra: string[] = [],
      url = mcpUrl,
    ) =>
      run(['hook', 'session-start', '--url', url, ...extra], {
        stdin: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd, session_id: 's0' }),
        env,
      })

    before(async () => {
      repo = await mkdtemp(join(tmpdir(), 'rsc-brain-repo-'))
      execFileSync('git', ['init', '-q', repo])
      execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:Acme/App.git'])
      const web = await w.web(eric.id)
      const linked = await w.callWeb(web, 'POST', '/v1/brains/alpha/repos', {
        repo: 'https://github.com/acme/app',
      })
      assert.ok(linked.status < 300, linked.text)
    })
    after(async () => rm(repo, { recursive: true, force: true }))

    it('session-start: the context of the brain linked to the repository, as additional context', async () => {
      const token = await w.token(eric.id)
      const r = await start({ RSC_BRAIN_TOKEN: token }, repo)
      assert.equal(r.code, 0, r.stderr)
      const out = JSON.parse(r.stdout) as { hookSpecificOutput: Json }
      assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart')
      const ctx = String(out.hookSpecificOutput.additionalContext)
      assert.match(ctx, /alpha/)
      assert.match(ctx, /What this brain knows/)
      assert.match(ctx, /Retention first/)
      assert.ok(ctx.length <= 10_000, 'within what Claude Code takes inline')
      assert.ok(!r.stdout.includes(token))
    })

    it('session-start: --brain when no repository is linked; nothing when there is neither; open on failure', async () => {
      const token = await w.token(eric.id)
      const plain = await mkdtemp(join(tmpdir(), 'rsc-brain-plain-'))
      try {
        const named = await start({ RSC_BRAIN_TOKEN: token }, plain, ['--brain', 'alpha'])
        assert.equal(named.code, 0)
        assert.match(JSON.parse(named.stdout).hookSpecificOutput.additionalContext, /Retention first/)
        const nothing = await start({ RSC_BRAIN_TOKEN: token }, plain)
        assert.deepEqual([nothing.code, nothing.stdout], [0, ''])
        const port = await deadPort()
        const down = await start({ RSC_BRAIN_TOKEN: token }, repo, [], `http://127.0.0.1:${port}/mcp`)
        assert.deepEqual([down.code, down.stdout], [0, ''])
        const noToken = await start({ RSC_BRAIN_TOKEN: undefined, HOME: stateDir }, repo)
        assert.deepEqual([noToken.code, noToken.stdout], [0, ''])
      } finally {
        await rm(plain, { recursive: true, force: true })
      }
    })

    it('stop: a session without summary blocks once, asking for mem_session_summary', async () => {
      const p = await w.person('Stopper')
      await w.member('alpha', p.id, 'contributor')
      const token = await w.token(p.id)
      const opened = await w.call(token, 'POST', '/v1/brains/alpha/sessions', { purpose: 'work' })
      const sid = (opened.body.session as Json).id as string
      // The agent is already continuing because of a stop hook: let it stop, and keep the ask for later.
      const active = await stop({ RSC_BRAIN_TOKEN: token }, { session_id: 'cc-1', stop_hook_active: true })
      assert.deepEqual([active.code, active.stdout], [0, ''])
      const r = await stop({ RSC_BRAIN_TOKEN: token }, { session_id: 'cc-1', stop_hook_active: false })
      assert.equal(r.code, 0, r.stderr)
      const out = JSON.parse(r.stdout) as { decision: string; reason: string }
      assert.equal(out.decision, 'block')
      assert.match(out.reason, /mem_session_summary/)
      assert.ok(out.reason.includes(sid), 'names the session to close')
      // Asked once in this Claude Code session; the next stop lets it go.
      const again = await stop({ RSC_BRAIN_TOKEN: token }, { session_id: 'cc-1', stop_hook_active: false })
      assert.deepEqual([again.code, again.stdout], [0, ''])
      // Another Claude Code session is asked on its own.
      const other = await stop({ RSC_BRAIN_TOKEN: token }, { session_id: 'cc-9', stop_hook_active: false })
      assert.equal((JSON.parse(other.stdout) as { decision: string }).decision, 'block')
      // With the summary written, nothing is asked, even in a new Claude Code session.
      const summary = await w.call(token, 'POST', `/v1/sessions/${sid}/summary`, {
        content: 'Goal: x. Done: y.',
      })
      assert.equal(summary.status, 201, summary.text)
      const done = await stop({ RSC_BRAIN_TOKEN: token }, { session_id: 'cc-2', stop_hook_active: false })
      assert.deepEqual([done.code, done.stdout], [0, ''])
    })

    it('stop: the agent writes with its own key (the standard sign-in) and the reminder runs with a token', async () => {
      const p = await w.person('Signedin')
      await w.member('alpha', p.id, 'contributor')
      // The agent's key is not the hook's: here, the person's main key stands for the connection key.
      const opened = await w.call(p.key, 'POST', '/v1/brains/alpha/sessions', { purpose: 'agent work' })
      const sid = (opened.body.session as Json).id as string
      const hookToken = await w.token(p.id)
      const r = await stop({ RSC_BRAIN_TOKEN: hookToken }, { session_id: 'cc-s', stop_hook_active: false })
      assert.ok(r.stdout.includes(sid), r.stdout || r.stderr)
    })

    it('stop: what was saved without opening a session (the day session) also asks for a summary', async () => {
      const token = await w.token(eric.id)
      await w.call(token, 'POST', '/v1/brains/alpha/entries', {
        type: 'note',
        title: 'n',
        content: 'Loose note.',
      })
      const r = await stop({ RSC_BRAIN_TOKEN: token }, { session_id: 'cc-3', stop_hook_active: false })
      assert.equal(JSON.parse(r.stdout).decision, 'block')
    })

    it('stop: open on failure: server down, no token, unreadable input', async () => {
      const token = await w.token(eric.id)
      await w.call(token, 'POST', '/v1/brains/alpha/sessions', { purpose: 'open' })
      const port = await deadPort()
      const down = await stop(
        { RSC_BRAIN_TOKEN: token },
        { session_id: 'cc-4' },
        `http://127.0.0.1:${port}/mcp`,
      )
      assert.deepEqual([down.code, down.stdout], [0, ''])
      const noToken = await stop({ RSC_BRAIN_TOKEN: undefined, HOME: stateDir }, { session_id: 'cc-4' })
      assert.deepEqual([noToken.code, noToken.stdout], [0, ''])
      const garbage = await run(['hook', 'stop', '--url', mcpUrl], {
        stdin: '{ nope',
        env: { RSC_BRAIN_TOKEN: token, RSC_BRAIN_STATE_DIR: stateDir },
      })
      assert.deepEqual([garbage.code, garbage.stdout], [0, ''])
    })
  })

  describe('GET /v1/me/sessions', () => {
    it("a person's key lists that person's open sessions, in brains it can see; a service key only its own", async () => {
      const p = await w.person('Lister')
      await w.member('alpha', p.id, 'contributor')
      await w.call(eric.key, 'POST', '/v1/brains', { slug: 'beta-kit' })
      await w.member('beta-kit', p.id, 'contributor')
      const mine = await w.token(p.id)
      const other = await w.token(p.id)
      const s1 = await w.call(mine, 'POST', '/v1/brains/alpha/sessions', { purpose: 'mine' })
      const s2 = await w.call(other, 'POST', '/v1/brains/beta-kit/sessions', { purpose: 'other key' })
      const closed = await w.call(mine, 'POST', '/v1/brains/alpha/sessions', { purpose: 'closed' })
      await w.call(mine, 'POST', `/v1/sessions/${(closed.body.session as Json).id}/end`)
      await w.call(eric.key, 'POST', '/v1/brains/alpha/sessions', { purpose: 'someone else' })
      const r = await w.call(mine, 'GET', '/v1/me/sessions')
      assert.equal(r.status, 200, r.text)
      const ids = (r.body.items as Json[]).map((x) => [x.id, x.brain, x.status])
      assert.deepEqual(
        ids.sort(),
        [
          [(s1.body.session as Json).id, 'alpha', 'open'],
          [(s2.body.session as Json).id, 'beta-kit', 'open'],
        ].sort(),
      )
      // A token for alpha only does not hear of beta.
      const narrow = await w.token(p.id, {
        brainIds: [String((await w.db.one('SELECT id FROM brains WHERE slug = $1', ['alpha']))?.id)],
      })
      const n = await w.call(narrow, 'GET', '/v1/me/sessions')
      assert.deepEqual(
        (n.body.items as Json[]).map((x) => x.brain),
        ['alpha'],
      )
      // A service runs agents for several people: its key sees only what it opened itself.
      const svc = await w.service('ListerSvc')
      await w.member('alpha', svc.id, 'contributor')
      const short = await w.call(svc.key, 'POST', '/v1/keys/short', {
        writeBrain: 'alpha',
        ref: 'r',
        ttlMinutes: 10,
      })
      const shortKey = String((short.body.key as { secret: string }).secret)
      await w.call(shortKey, 'POST', '/v1/brains/alpha/sessions', { purpose: 'agent' })
      assert.deepEqual((await w.call(svc.key, 'GET', '/v1/me/sessions')).body.items, [])
    })
  })
})
