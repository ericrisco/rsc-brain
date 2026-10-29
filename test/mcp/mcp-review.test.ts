// Review of B5 PR14: the default brain never names brains a key cannot see; repositories are linked
// per brain (nobody squats one); every refusal through a tool says how to proceed; malformed values
// are tool errors, not server errors; the protocol edges.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { MODERN } from '../../src/mcp/server.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

const META = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientInfo': { name: 'test-agent', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
}
const SHAPE = /^[a-z_]+: .+ How to proceed: .+/s

describe('the MCP endpoint: review', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let n = 0

  async function rpc(key: string, method: string, params: Record<string, unknown> = {}, id: unknown = ++n) {
    const res = await fetch(`${w.base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        'mcp-protocol-version': MODERN,
        'mcp-method': method,
        ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: META } }),
    })
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown> & {
        result?: Record<string, unknown>
        error?: { code: number; message: string }
      },
    }
  }
  const call = async (key: string, name: string, args: Record<string, unknown> = {}) => {
    const r = await rpc(key, 'tools/call', { name, arguments: args })
    const res = r.body.result as {
      content: Array<{ text: string }>
      structuredContent?: Record<string, unknown>
      isError: boolean
    }
    return {
      status: r.status,
      isError: res?.isError,
      text: res?.content?.[0]?.text ?? '',
      data: res?.structuredContent,
      rpc: r.body,
    }
  }
  const brainId = async (slug: string) =>
    String((await w.db.one('SELECT id FROM brains WHERE slug = $1', [slug]))?.id)

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    for (const slug of ['alpha', 'beta', 'topsecret']) await w.call(eric.key, 'POST', '/v1/brains', { slug })
  })
  after(async () => w.close())

  it('a narrowed key is never told the names of brains it cannot see', async () => {
    const narrow = await w.token(eric.id, { brainIds: [await brainId('alpha'), await brainId('beta')] })
    const r = await call(narrow, 'mem_save', { type: 'learning', title: 'x', content: 'y' })
    assert.equal(r.isError, true)
    assert.match(r.text, /alpha, beta/)
    assert.ok(!r.text.includes('topsecret'), r.text)
  })

  it('a session this key cannot use answers like one that does not exist', async () => {
    const other = await w.person('Other')
    await w.call(other.key, 'POST', '/v1/brains', { slug: 'theirs' })
    const s = await call(other.key, 'mem_session_start', { brain: 'theirs', purpose: 'x' })
    const theirs = (s.data as { session: { id: string } }).session.id
    const a = await call(eric.key, 'mem_context', { session: theirs })
    const b = await call(eric.key, 'mem_context', { session: 'ses_000000000000' })
    assert.equal(a.text, b.text)
    assert.match(a.text, /not one this key can use/)
  })

  it('the default brain: a token for one brain, a key whose person has one brain, a short key', async () => {
    const one = await w.token(eric.id, { brainIds: [await brainId('beta')] })
    assert.equal(
      (await call(one, 'mem_save', { type: 'learning', title: 'Only beta', content: 'x' })).isError,
      false,
    )
    assert.equal(
      (
        await w.db.one(
          "SELECT b.slug FROM entries e JOIN brains b ON b.id = e.brain_id WHERE e.title = 'Only beta'",
        )
      )?.slug,
      'beta',
    )
    const solo = await w.person('Solo')
    await w.call(solo.key, 'POST', '/v1/brains', { slug: 'solo-brain' })
    assert.equal(
      (await call(solo.key, 'mem_save', { type: 'learning', title: 'Solo entry', content: 'x' })).isError,
      false,
    )
    const svc = await w.service('Svc')
    await w.member('alpha', svc.id, 'contributor')
    const main = await call(svc.key, 'mem_save', { type: 'learning', title: 'Main key entry', content: 'x' })
    assert.equal(main.isError, false, main.text)
    const short = await w.call(svc.key, 'POST', '/v1/keys/short', {
      writeBrain: 'alpha',
      ref: 'r',
      ttlMinutes: 10,
    })
    const shortKey = String((short.body.key as { secret: string }).secret)
    const names = (
      (await rpc(shortKey, 'tools/list')).body.result as { tools: Array<{ name: string }> }
    ).tools.map((t) => t.name)
    assert.ok(!names.includes('brain_create'))
  })

  it('repositories are linked per brain: one curator cannot take a repository from another', async () => {
    const mal = await w.person('Mal')
    await w.call(mal.key, 'POST', '/v1/brains', { slug: 'mal-private' })
    assert.equal(
      (
        await w.callWeb(await w.web(mal.id), 'POST', '/v1/brains/mal-private/repos', {
          repo: 'https://github.com/Acme/App',
        })
      ).status,
      201,
    )
    const mine = await w.callWeb(await w.web(eric.id), 'POST', '/v1/brains/alpha/repos', {
      repo: 'git@github.com:acme/app.git',
    })
    assert.equal(mine.status, 201, JSON.stringify(mine.body))
    const r = await call(eric.key, 'brain_resolve', { repos: ['https://github.com/acme/app'] })
    assert.equal((r.data as { brain: { slug: string } }).brain.slug, 'alpha')
    const m = await call(mal.key, 'brain_resolve', { repos: ['https://github.com/acme/app'] })
    assert.equal((m.data as { brain: { slug: string } }).brain.slug, 'mal-private')
    // Two of my brains on one repository: both offered, to choose.
    await w.callWeb(await w.web(eric.id), 'POST', '/v1/brains/beta/repos', { repo: 'github.com/acme/app' })
    const two = await call(eric.key, 'brain_resolve', { repos: ['github.com/acme/app'] })
    assert.deepEqual(
      (two.data as { brains: Array<{ slug: string }> }).brains.map((b) => b.slug),
      ['alpha', 'beta'],
    )
  })

  it('servers on one host with different ports are different repositories; the usual port is the same', async () => {
    const web = await w.web(eric.id)
    await w.callWeb(web, 'POST', '/v1/brains/topsecret/repos', { repo: 'ssh://git@git.corp:2222/team/svc' })
    const other = await call(eric.key, 'brain_resolve', { repos: ['https://git.corp:8443/team/svc'] })
    assert.equal((other.data as { brain: unknown }).brain, null)
    const same = await call(eric.key, 'brain_resolve', { repos: ['ssh://git@git.corp:2222/team/svc.git'] })
    assert.equal((same.data as { brain: { slug: string } }).brain.slug, 'topsecret')
    // The usual port of each scheme says nothing.
    await w.callWeb(web, 'POST', '/v1/brains/topsecret/repos', { repo: 'https://github.com/acme/tools' })
    for (const form of [
      'ssh://git@github.com:22/acme/tools',
      'git+ssh://git@github.com:22/acme/tools.git',
      'https://github.com:443/acme/tools',
    ]) {
      const r = await call(eric.key, 'brain_resolve', { repos: [form] })
      assert.equal((r.data as { brain: { slug: string } | null }).brain?.slug, 'topsecret', form)
    }
    // git@host:path has no port: a numeric owner is an owner.
    await w.callWeb(web, 'POST', '/v1/brains/topsecret/repos', { repo: 'https://github.com/2024/app' })
    const numeric = await call(eric.key, 'brain_resolve', { repos: ['git@github.com:2024/app.git'] })
    assert.equal((numeric.data as { brain: { slug: string } | null }).brain?.slug, 'topsecret')
  })

  it('a folder is answered with how to get the address', async () => {
    const r = await call(eric.key, 'brain_resolve', { repos: ['/Users/eric/dev/rsc-factory'] })
    assert.equal(r.isError, true)
    assert.match(r.text, /git remote get-url origin/)
  })

  it('CA9: every refusal reachable through a tool has a code, what happened and how to proceed', async () => {
    const ro = await w.token(eric.id, { perm: 'read' })
    const svc = await w.service('Svc2')
    await w.member('alpha', svc.id, 'contributor')
    const short = await w.call(svc.key, 'POST', '/v1/keys/short', {
      writeBrain: 'alpha',
      ref: 'r',
      ttlMinutes: 10,
    })
    const shortKey = String((short.body.key as { secret: string }).secret)
    const e = await call(eric.key, 'mem_save', {
      brain: 'alpha',
      type: 'learning',
      title: 'Source',
      content: 'S.',
    })
    const entryId = (e.data as { receipt: { entryId: string } }).receipt.entryId
    const op = {
      op: 'create',
      address: 'a/b',
      type: 'topic',
      title: 'A',
      summary: 'S.',
      body: 'B.',
      sources: [{ entryId }],
      reason: 'R.',
    }
    const p = await call(eric.key, 'brain_propose', { brain: 'alpha', title: 'P', ops: [op] })
    const pid = (p.data as { proposal: { id: string } }).proposal.id
    await call(eric.key, 'brain_withdraw', { id: pid })
    const results = {
      read_only_key: await call(ro, 'mem_save', {
        brain: 'alpha',
        type: 'learning',
        title: 'x',
        content: 'y',
      }),
      cannot_create_brains: await call(shortKey, 'brain_create', { slug: 'nope-brain' }),
      invalid_arguments: await rpc(eric.key, 'tools/call', { name: 'mem_get', arguments: [] }),
      empty_id: await call(eric.key, 'mem_get', { id: '' }),
      empty_address: await call(eric.key, 'brain_page', { brain: 'alpha', address: '' }),
      empty_session: await call(eric.key, 'mem_session_end', { session: '' }),
      not_found: await call(eric.key, 'mem_get', { id: 'ent_000000000000' }),
      brain_not_found: await call(eric.key, 'mem_context', { brain: 'no-such-brain' }),
      correction_type: await call(eric.key, 'mem_save', {
        brain: 'alpha',
        type: 'correction',
        title: 'x',
        content: 'y',
      }),
      decided: await call(eric.key, 'brain_withdraw', { id: pid }),
      proposal_problems: await call(eric.key, 'brain_propose', {
        brain: 'alpha',
        title: 'Bad',
        ops: [{ op: 'create' }],
      }),
      which_brain: await call(eric.key, 'mem_save', { type: 'learning', title: 'x', content: 'y' }),
    }
    for (const [name, r] of Object.entries(results)) {
      if ('rpc' in r) {
        assert.equal(r.status, 200, name)
        assert.equal(r.isError, true, name)
        assert.match(r.text, SHAPE, `${name}: ${r.text}`)
      } else {
        const res = r.body.result as { content: Array<{ text: string }>; isError: boolean }
        assert.equal(res.isError, true, name)
        assert.match(res.content[0]?.text ?? '', SHAPE, name)
      }
    }
    const unknown = await rpc(eric.key, 'tools/call', { name: 'no_such_tool', arguments: {} })
    assert.match(String(unknown.body.error?.message), /tools\/list/)
  })

  it('a brain someone added me to is not chosen alone for my repository until I work in it', async () => {
    const victim = await w.person('Victim')
    const mal = await w.person('Mal2')
    await w.call(mal.key, 'POST', '/v1/brains', { slug: 'mal-trap' })
    await w.member('mal-trap', victim.id, 'contributor')
    await w.callWeb(await w.web(mal.id), 'POST', '/v1/brains/mal-trap/repos', {
      repo: 'https://github.com/victimco/secret-app',
    })
    const r = await call(victim.key, 'brain_resolve', { repos: ['git@github.com:victimco/secret-app.git'] })
    const d = r.data as { brain: unknown; brains: Array<{ slug: string }>; howToProceed: string }
    assert.equal(d.brain, null)
    assert.deepEqual(
      d.brains.map((b) => b.slug),
      ['mal-trap'],
    )
    assert.match(d.howToProceed, /Ask the person/)
    // Once the person chose it and worked in it, it is chosen alone.
    await call(victim.key, 'mem_save', { brain: 'mal-trap', type: 'note', title: 'Chosen', content: 'x' })
    const again = await call(victim.key, 'brain_resolve', { repos: ['github.com/victimco/secret-app'] })
    assert.equal((again.data as { brain: { slug: string } }).brain.slug, 'mal-trap')
  })

  it('values that cannot become text are refused, never a server error', async () => {
    const odd = { toString: 1 }
    const tool = await rpc(eric.key, 'tools/call', { name: odd, arguments: {} })
    assert.deepEqual([tool.status, tool.body.error?.code], [400, -32602])
    const prompt = await rpc(eric.key, 'prompts/get', { name: odd })
    assert.deepEqual([prompt.status, prompt.body.error?.code], [400, -32602])
    const withArg = await rpc(eric.key, 'prompts/get', { name: 'compile_brain', arguments: { brain: odd } })
    assert.equal(withArg.status, 200)
    for (const [name, args] of [
      ['mem_search', { brain: 'alpha', q: odd }],
      ['brain_proposals', { brain: 'alpha', status: odd }],
    ] as const) {
      const r = await call(eric.key, name, args)
      assert.equal(r.status, 200, name)
      assert.equal(r.isError, true, name)
      assert.match(r.text, SHAPE, name)
    }
  })

  it('a short key writes to its own brain even when its service is in several', async () => {
    const svc = await w.service('Svc3')
    await w.member('alpha', svc.id, 'contributor')
    await w.member('beta', svc.id, 'contributor')
    const short = await w.call(svc.key, 'POST', '/v1/keys/short', {
      writeBrain: 'beta',
      readBrains: ['alpha'],
      onBehalf: eric.id,
      ref: 'r',
      ttlMinutes: 10,
    })
    assert.equal(short.status, 201, JSON.stringify(short.body))
    const shortKey = String((short.body.key as { secret: string }).secret)
    const r = await call(shortKey, 'mem_save', { type: 'learning', title: 'Short to beta', content: 'x' })
    assert.equal(r.isError, false, r.text)
    const row = await w.db.one(
      "SELECT b.slug FROM entries e JOIN brains b ON b.id = e.brain_id WHERE e.title = 'Short to beta'",
    )
    assert.equal(row?.slug, 'beta')
  })

  it('brain_proposals shows only my proposals', async () => {
    const other = await w.person('Author')
    await w.member('alpha', other.id, 'contributor')
    const e = await call(other.key, 'mem_save', {
      brain: 'alpha',
      type: 'learning',
      title: 'Theirs',
      content: 'T.',
    })
    const entryId = (e.data as { receipt: { entryId: string } }).receipt.entryId
    const op = {
      op: 'create',
      address: 'theirs/page',
      type: 'topic',
      title: 'Theirs',
      summary: 'S.',
      body: 'B.',
      sources: [{ entryId }],
      reason: 'R.',
    }
    const p = await call(other.key, 'brain_propose', { brain: 'alpha', title: 'Their proposal', ops: [op] })
    const theirId = (p.data as { proposal: { id: string } }).proposal.id
    const mine = (await call(eric.key, 'brain_proposals', { brain: 'alpha' })).data as {
      items: Array<{ id: string }>
    }
    assert.ok(!mine.items.some((x) => x.id === theirId))
    const theirs = (await call(other.key, 'brain_proposals', { brain: 'alpha' })).data as {
      items: Array<{ id: string }>
    }
    assert.ok(theirs.items.some((x) => x.id === theirId))
  })

  it('mem_timeline with a null id lists recent work; mem_context accepts what the server serves', async () => {
    const t = await call(eric.key, 'mem_timeline', { brain: 'alpha', id: null })
    assert.equal(t.isError, false, t.text)
    const tools = (
      (await rpc(eric.key, 'tools/list')).body.result as {
        tools: Array<{
          name: string
          inputSchema: { properties: Record<string, { minimum?: number; maximum?: number }> }
        }>
      }
    ).tools
    const max = tools.find((x) => x.name === 'mem_context')?.inputSchema.properties.max
    assert.deepEqual([max?.minimum, max?.maximum], [4000, 128000])
  })

  it('version refusals never list the version they refuse', async () => {
    const legacyInMeta = await fetch(`${w.base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${eric.key}`,
        'mcp-protocol-version': '2025-11-25',
        'mcp-method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-11-25' } },
      }),
    })
    const a = (await legacyInMeta.json()) as { error: { code: number; data: { supported: string[] } } }
    assert.equal(a.error.code, -32022)
    assert.ok(!a.error.data.supported.includes('2025-11-25'))
    const modernNoMeta = await fetch(`${w.base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${eric.key}`,
        'mcp-protocol-version': MODERN,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    })
    const b = (await modernNoMeta.json()) as { error: { code: number; message: string } }
    assert.equal(modernNoMeta.status, 400)
    assert.equal(b.error.code, -32602)
    assert.match(b.error.message, /_meta/)
    const unknownHeader = await fetch(`${w.base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${eric.key}`,
        'mcp-protocol-version': '2099-01-01',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    })
    assert.equal(((await unknownHeader.json()) as { error: { code: number } }).error.code, -32022)
    const unknownTool = await rpc(eric.key, 'tools/call', { name: 'nope', arguments: {} })
    assert.equal(unknownTool.status, 400)
  })

  it('protocol edges: an object id is refused; an old client asking 2025-03-26 gets a version it can use', async () => {
    const bad = await rpc(eric.key, 'tools/list', {}, { a: 1 })
    assert.deepEqual([bad.status, bad.body.error?.code], [400, -32600])
    const res = await fetch(`${w.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${eric.key}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'old', version: '1' },
        },
      }),
    })
    const init = (await res.json()) as { result: { protocolVersion: string } }
    assert.equal(init.result.protocolVersion, '2025-11-25')
  })
})
