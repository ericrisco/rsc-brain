// The logic behind Profile and «Connect your agent» (spec B6 «Profile», «Connect your agent»), kept out
// of the screens so it is tested on its own (plan §2: the .tsx files only paint).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkOf, fillToken, toAsk } from '../../web/src/lib/connect.ts'
import {
  brainsLabel,
  groupKey,
  lastUseLabel,
  notifyRows,
  permLabel,
  tokenRequest,
} from '../../web/src/lib/profile.ts'

const NOW = new Date('2026-11-01T12:00:00.000Z')
const token = (o: { id?: string; lastUsedAt?: string | null; lastClient?: string | null } = {}) => ({
  id: 'crd_1',
  lastUsedAt: null as string | null,
  lastClient: null as string | null,
  ...o,
})

describe('a token in the list', () => {
  it('says which brains it reaches', () => {
    assert.equal(
      brainsLabel({ allBrains: true, brains: null }),
      'All your brains, and the ones you join later',
    )
    assert.equal(brainsLabel({ allBrains: false, brains: ['growth'] }), 'growth')
    assert.equal(brainsLabel({ allBrains: false, brains: ['growth', 'support'] }), 'growth, support')
  })
  it('says what it may do in words', () => {
    assert.equal(permLabel('read'), 'Read')
    assert.equal(permLabel('write'), 'Read and write')
  })
  it('says when it was last used and by what, never a raw user agent', () => {
    assert.equal(lastUseLabel(token(), NOW), 'Never used')
    assert.equal(
      lastUseLabel(token({ lastUsedAt: '2026-11-01T11:58:00.000Z', lastClient: 'claude-code/2.1.3' }), NOW),
      'Used 2 min ago by Claude Code',
    )
    assert.equal(
      lastUseLabel(token({ lastUsedAt: '2026-10-31T09:00:00.000Z', lastClient: 'node' }), NOW),
      'Used yesterday by an API client',
    )
    assert.equal(lastUseLabel(token({ lastUsedAt: '2026-11-01T11:59:50.000Z' }), NOW), 'Used just now')
  })
})

describe('a new token, from the form', () => {
  const base = { name: 'Laptop', perm: 'write' as const, days: 90, scope: 'all' as const, brains: [] }
  it('asks for all brains, or for the ones chosen', () => {
    assert.deepEqual(tokenRequest(base), {
      body: { name: 'Laptop', perm: 'write', days: 90, allBrains: true },
      problems: {},
    })
    assert.deepEqual(tokenRequest({ ...base, scope: 'some', brains: ['growth', 'support'] }), {
      body: { name: 'Laptop', perm: 'write', days: 90, brains: ['growth', 'support'] },
      problems: {},
    })
  })
  it('says what to fix before anything is sent: a name, a length, at least one brain', () => {
    assert.deepEqual(tokenRequest({ ...base, name: '  ' }).problems, { name: 'Enter a name.' })
    assert.equal(tokenRequest({ ...base, name: '  ' }).body, null)
    assert.deepEqual(tokenRequest({ ...base, name: 'x'.repeat(81) }).problems, {
      name: 'Shorten the name to 80 characters or fewer.',
    })
    assert.deepEqual(tokenRequest({ ...base, scope: 'some', brains: [] }).problems, {
      brains: 'Choose at least one brain, or all of them.',
    })
    assert.equal(tokenRequest({ ...base, name: ' Laptop ' }).body?.name, 'Laptop')
  })
})

describe('email notices by brain', () => {
  it('only a curator can choose; everyone else learns why', () => {
    const rows = notifyRows([
      { slug: 'growth', name: 'Growth', role: 'curator', notifyProposals: true, status: 'active' },
      { slug: 'support', name: 'Support', role: 'reader', notifyProposals: false, status: 'active' },
    ])
    assert.deepEqual(rows, [
      { slug: 'growth', name: 'Growth', on: true, can: true },
      { slug: 'support', name: 'Support', on: false, can: false },
    ])
  })
})

describe('the key of the second factor', () => {
  it('reads in groups of four', () => {
    assert.equal(groupKey('JBSWY3DPEHPK3PXPJBSW'), 'JBSW Y3DP EHPK 3PXP JBSW')
    assert.equal(groupKey('ABCDEF'), 'ABCD EF')
  })
})

describe('the configuration with the token filled in', () => {
  const blocks = [
    { title: 'env', where: 'terminal', format: 'shell', text: 'export RSC_BRAIN_TOKEN="<paste-your-token>"' },
    {
      title: 'file',
      where: '.mcp.json',
      format: 'json',
      text: `{"Authorization":"Bearer $\{RSC_BRAIN_TOKEN}"}`,
    },
    { title: 'two', where: 'remote', format: 'text', text: 'a <paste-your-token> b <paste-your-token>' },
  ]
  it('puts the token where the kit has the placeholder, and nowhere else', () => {
    const out = fillToken(blocks, '<paste-your-token>', 'rscb_secret1234')
    assert.equal(out[0]?.text, 'export RSC_BRAIN_TOKEN="rscb_secret1234"')
    assert.equal(out[1]?.text, blocks[1]?.text)
    assert.equal(out[2]?.text, 'a rscb_secret1234 b rscb_secret1234')
    // The kit itself is untouched (it is cached and shown again later without the token).
    assert.equal(blocks[0]?.text, 'export RSC_BRAIN_TOKEN="<paste-your-token>"')
  })
})

describe('the live check', () => {
  it('asks for the apps first (to know which were there), and for the tokens once one was made here', () => {
    assert.deepEqual(toAsk({ tokenId: null, knownApps: null }), ['apps'])
    assert.deepEqual(toAsk({ tokenId: null, knownApps: new Set() }), ['apps'])
    assert.deepEqual(toAsk({ tokenId: 'crd_1', knownApps: new Set() }), ['tokens', 'apps'])
  })
  it('turns green on the first request of the token made here', () => {
    assert.deepEqual(checkOf({ tokenId: 'crd_1', knownApps: new Set(), tokens: [token()], apps: [] }), {
      kind: 'waiting',
    })
    // Another token used meanwhile is not this agent.
    assert.deepEqual(
      checkOf({
        tokenId: 'crd_1',
        knownApps: new Set(),
        tokens: [token(), token({ id: 'crd_2', lastUsedAt: '2026-11-01T11:59:00.000Z' })],
      }),
      { kind: 'waiting' },
    )
    assert.deepEqual(
      checkOf({
        tokenId: 'crd_1',
        knownApps: new Set(),
        tokens: [token({ lastUsedAt: '2026-11-01T11:59:00.000Z', lastClient: 'claude-code/2.1' })],
      }),
      { kind: 'connected', via: 'token', at: '2026-11-01T11:59:00.000Z', client: 'Claude Code' },
    )
  })
  it('turns green when a connection appears that was not there when the page opened', () => {
    const app = (id: string, name = 'Claude Code') => ({ id, name, lastUsedAt: '2026-11-01T11:59:00.000Z' })
    assert.deepEqual(checkOf({ tokenId: null, knownApps: new Set(['app_old']), apps: [app('app_old')] }), {
      kind: 'waiting',
    })
    assert.deepEqual(
      checkOf({
        tokenId: null,
        knownApps: new Set(['app_old']),
        apps: [app('app_old'), app('app_new', 'Cursor')],
      }),
      { kind: 'connected', via: 'app', at: '2026-11-01T11:59:00.000Z', client: 'Cursor' },
    )
    // Before the first answer there is nothing to compare with: never green by accident.
    assert.deepEqual(checkOf({ tokenId: null, knownApps: null, apps: [app('app_new')] }), { kind: 'waiting' })
  })
})
