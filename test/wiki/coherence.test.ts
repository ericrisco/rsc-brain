// Spec v0.6 «Avisos de incoherencia», CA7–CA9: whoever proposes or writes gets, in the same answer, what their
// change would leave incoherent — worked out on the wiki as it would be after it — and the pages linked to what it
// touches, to look for contradictions in meaning themselves (the server uses no AI: P2). They can ask first,
// without writing anything. Warnings never block.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>
type Coherence = { code: string; message: string; addresses: string[] }
type Neighbour = { address: string; title: string; summary: string; revision: number }

describe('coherence warnings and neighbours (v0.6)', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let ana: { id: string; key: string }
  let ericWeb: string
  let writer: string
  let source: string

  const change = (op: Json) => w.callWeb(ericWeb, 'POST', '/v1/brains/yt/wiki/changes', op)
  const plant = async (address: string, title: string, body = `About ${address}.`) => {
    const r = await change({ op: 'create', address, type: 'topic', title, summary: `${title}.`, body })
    assert.equal(r.status, 201, r.text)
  }
  // The change of CA7: a title almost the same as another, a link to nowhere, a page nobody links to, an edit of
  // a stale page, and a page with an open contradiction touched.
  const ops = (n: string): Json[] => [
    {
      op: 'create',
      address: `lonely-${n}`,
      type: 'topic',
      title: 'Audience retention',
      summary: 'Again.',
      body: `Nothing links here, and it links to [[missing-${n}]] only.`,
      sources: [{ entryId: source }],
      reason: 'From the journal.',
    },
    {
      op: 'edit',
      address: 'old-intro',
      baseRevision: 1,
      body: 'Refreshed. See [[hooks]].',
      reason: 'Newer.',
    },
    // And a link from a page with an open contradiction.
    { op: 'link', address: 'hooks', kind: 'related', to: 'old-intro', reason: 'Related.' },
  ]
  const codes = (list: Coherence[]) =>
    list
      .map((c) => [c.code, [...c.addresses].sort().join(' ')])
      .sort((a, b) => String(a).localeCompare(String(b)))

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    ana = await w.person('Ana')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'yt', purpose: 'Our channel.' })
    await w.member('yt', ana.id, 'contributor')
    ericWeb = await w.web(eric.id)
    const anaWeb = await w.web(ana.id)
    const t = await w.callWeb(anaWeb, 'POST', '/v1/me/tokens', {
      name: 'Ana agent',
      perm: 'write',
      brains: ['yt'],
      days: 30,
    })
    writer = (t.body.token as { secret: string }).secret
    await w.callWeb(ericWeb, 'PUT', `/v1/brains/yt/wiki/writers/${(t.body.token as { id: string }).id}`)
    await plant('audience/retention', 'Audience retention', 'How viewers stay. See [[hooks]].')
    await plant('hooks', 'Hooks', 'The first seconds. See [[audience/retention]].')
    await plant('old-intro', 'Old intro', 'How we opened videos. See [[hooks]].')
    // "hooks" contradicts another page, and the intro is stale.
    await plant('hooks-alt', 'Hooks the other way', 'Longer intros. See [[hooks]].')
    assert.equal(
      (
        await change({
          op: 'link',
          address: 'hooks',
          kind: 'contradicts',
          to: 'hooks-alt',
          reason: 'They disagree.',
        })
      ).status < 300,
      true,
    )
    assert.equal(
      (await change({ op: 'status', address: 'old-intro', status: 'stale', reason: 'Old.' })).status < 300,
      true,
    )
    const e = await w.call(ana.key, 'POST', '/v1/brains/yt/entries', {
      type: 'fact',
      title: 'Retention',
      content: 'People leave at second 30.',
    })
    source = (e.body.receipt as { entryId: string }).entryId
  })
  after(async () => w.close())

  const expected = (n: string) =>
    [
      ['broken_link', `lonely-${n} missing-${n}`],
      ['duplicate_title', `audience/retention lonely-${n}`],
      ['open_conflict', 'hooks hooks-alt'],
      ['orphan_created', `lonely-${n}`],
      ['stale_page', 'old-intro'],
    ].sort((a, b) => String(a).localeCompare(String(b)))

  it('CA8: asking first returns the warnings and changes nothing', async () => {
    const pages = await w.db.one('SELECT count(*)::int AS n, sum(revision)::int AS r FROM pages')
    const r = await w.call(ana.key, 'POST', '/v1/brains/yt/wiki/check', { title: 'Check', ops: ops('a') })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.body.problems, [])
    assert.deepEqual(codes(r.body.coherence as Coherence[]), expected('a'))
    assert.deepEqual(await w.db.one('SELECT count(*)::int AS n, sum(revision)::int AS r FROM pages'), pages)
    assert.equal(
      (await w.db.one('SELECT count(*)::int AS n FROM wiki_log WHERE kind <> $1', ['direct']))?.n,
      0,
    )
    // With blocking problems, those come back and nothing is worked out.
    const bad = await w.call(ana.key, 'POST', '/v1/brains/yt/wiki/check', {
      title: 'Check',
      ops: [{ op: 'link', address: 'hooks', kind: 'related', to: 'nowhere', reason: 'x' }],
    })
    assert.equal(bad.status, 200, bad.text)
    assert.equal((bad.body.problems as unknown[]).length, 1)
  })

  it('CA7: a proposal brings the warnings, with the addresses, and still goes in', async () => {
    const r = await w.call(ana.key, 'POST', '/v1/brains/yt/proposals', { title: 'Lonely', ops: ops('b') })
    assert.equal(r.status, 201, r.text)
    assert.deepEqual(codes(r.body.coherence as Coherence[]), expected('b'))
    for (const c of r.body.coherence as Coherence[]) assert.ok(c.message.length > 10)
    // Simulated only: the proposal waits, the wiki is as it was.
    assert.equal((await w.call(eric.key, 'GET', '/v1/brains/yt/pages/lonely-b')).status, 404)
  })

  it('CA7: a direct write brings them too, on what it wrote', async () => {
    const intro = (await w.call(eric.key, 'GET', '/v1/brains/yt/pages/old-intro')).body.page as {
      revision: number
    }
    const o = ops('c')
    ;(o[1] as Json).baseRevision = intro.revision
    const r = await w.call(writer, 'POST', '/v1/brains/yt/wiki/write', { title: 'Lonely', ops: o })
    assert.equal(r.status, 201, r.text)
    assert.deepEqual(codes(r.body.coherence as Coherence[]), expected('c'))
    assert.equal((await w.call(eric.key, 'GET', '/v1/brains/yt/pages/lonely-c')).status, 200)
  })

  it('CA9: the neighbours of what is touched, with title, address, summary and revision', async () => {
    const r = await w.call(ana.key, 'POST', '/v1/brains/yt/wiki/check', {
      title: 'Edit hooks',
      ops: [
        { op: 'edit', address: 'hooks', baseRevision: 2, summary: 'The first five seconds.', reason: 'x' },
      ],
    })
    assert.equal(r.status, 200, r.text)
    const n = r.body.neighbours as Neighbour[]
    const addresses = n.map((x) => x.address).sort()
    // Linked from it, and linking to it: retention both ways, the intro and the other view.
    assert.ok(
      ['audience/retention', 'hooks-alt', 'old-intro'].every((a) => addresses.includes(a)),
      addresses.join(', '),
    )
    assert.ok(!addresses.includes('hooks'))
    const retention = n.find((x) => x.address === 'audience/retention')
    assert.deepEqual(
      [retention?.title, retention?.summary, typeof retention?.revision],
      ['Audience retention', 'Audience retention.', 'number'],
    )
  })
})
