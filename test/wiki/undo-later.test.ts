// Review round 1 of T005–T008 (correctness): an undo puts back only what the change itself changed. What a later write
// did — a link into the page, an address another page took — is never lost silently: it stays, or it is a conflict a
// person decides. A part that cannot be put back (its revision before was purged) stops the whole undo. Parts of the
// proposal still waiting that need an undone part go with it. Spec learning-memory A2, CA-A10. Round 2 (V1–V3): the links
// into a page come back as the exact inverse of what the change itself did to them, whatever other pages it touched; a
// proposal left with nothing waiting stops counting as waiting.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>

describe('undo leaves later writes alone (review round 1)', { skip: skipPg }, () => {
  let w: World
  let cora: { id: string; key: string }
  let cole: { id: string; key: string }
  let coraWeb: string
  let writer: string
  let source: string

  const create = (address: string, extra: Json = {}) => ({
    op: 'create',
    address,
    type: 'topic',
    title: `Page ${address}`,
    summary: `About ${address}.`,
    body: `Text of ${address}.`,
    sources: [{ entryId: source }],
    reason: 'From the journal.',
    ...extra,
  })
  const byWeb = async (op: Json) => {
    const r = await w.callWeb(coraWeb, 'POST', '/v1/brains/ul/wiki/changes', op)
    assert.ok(r.status < 300, r.text)
    return r
  }
  const plant = (address: string, extra: Json = {}) =>
    byWeb({ op: 'create', address, type: 'topic', title: address, summary: address, body: address, ...extra })
  const undo = (id: string, body: Json = {}, key?: string) =>
    key
      ? w.call(key, 'POST', `/v1/wiki/changes/${id}/undo`, body)
      : w.callWeb(coraWeb, 'POST', `/v1/wiki/changes/${id}/undo`, body)
  const links = async (from: string) =>
    (
      await w.db.query<{ kind: string; to: string }>(
        `SELECT l.kind, t.address AS to FROM page_links l JOIN pages f ON f.id = l.from_page JOIN pages t ON t.id = l.to_page
          JOIN brains b ON b.id = f.brain_id WHERE b.slug = 'ul' AND f.address = $1 AND f.status <> 'retired' ORDER BY 1, 2`,
        [from],
      )
    ).map((l) => `${l.kind} ${l.to}`)
  const holder = async (address: string) =>
    (
      await w.db.one<{ title: string }>(
        `SELECT p.title FROM page_addresses a JOIN pages p ON p.id = a.page_id JOIN brains b ON b.id = a.brain_id
          WHERE b.slug = 'ul' AND a.address = $1`,
        [address],
      )
    )?.title

  before(async () => {
    w = await world()
    cora = await w.person('Cora')
    cole = await w.person('Cole')
    await w.call(cora.key, 'POST', '/v1/brains', { slug: 'ul', purpose: 'Undo later.' })
    await w.member('ul', cole.id, 'contributor')
    coraWeb = await w.web(cora.id)
    const coleWeb = await w.web(cole.id)
    const t = await w.callWeb(coleWeb, 'POST', '/v1/me/tokens', {
      name: 'Cole writer',
      perm: 'write',
      brains: ['ul'],
      days: 30,
    })
    const tok = t.body.token as { id: string; secret: string }
    writer = tok.secret
    assert.equal((await w.callWeb(coraWeb, 'PUT', `/v1/brains/ul/wiki/writers/${tok.id}`)).status, 200)
    const e = await w.call(cole.key, 'POST', '/v1/brains/ul/entries', {
      type: 'learning',
      title: 'S',
      content: 'S.',
    })
    source = (e.body.receipt as { entryId: string }).entryId
  })
  after(async () => w.close())

  it('U1: a link into the page that a later page made stays after the undo', async () => {
    await plant('pa')
    const c = await w.call(cole.key, 'POST', '/v1/brains/ul/proposals', {
      title: 'Edit pa',
      ops: [{ op: 'edit', address: 'pa', baseRevision: 1, body: 'Agent words.', reason: 'R.' }],
    })
    await plant('qa', { links: [{ kind: 'related', to: 'pa' }] })
    const r = await undo(String(c.body.undo))
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(await links('qa'), ['related pa'])
  })

  it('U2: a part whose revision before was purged stops the whole undo (409 undo_purged); nothing changes', async () => {
    await plant('bx')
    await plant('by')
    const c = await w.call(cole.key, 'POST', '/v1/brains/ul/proposals', {
      title: 'Merge',
      ops: [
        {
          op: 'merge',
          address: 'bx',
          from: 'by',
          body: 'Both.',
          dropSources: [],
          dropLinks: [],
          reason: 'Same.',
        },
      ],
    })
    await w.db.query(
      `UPDATE page_revisions r SET purged_at = now(), body = '' FROM pages p JOIN brains b ON b.id = p.brain_id
        WHERE r.page_id = p.id AND b.slug = 'ul' AND p.address = 'by' AND r.revision = 1`,
    )
    const before = await w.db.query('SELECT address, status, revision, body FROM pages ORDER BY id')
    const r = await undo(String(c.body.undo))
    assert.equal(r.status, 409, r.text)
    assert.equal(r.body.error?.code, 'undo_purged')
    assert.match(String(r.body.error?.message), /by/)
    assert.deepEqual(
      await w.db.query('SELECT address, status, revision, body FROM pages ORDER BY id'),
      before,
    )
    assert.equal(await holder('by'), 'bx')
  })

  it('U3: a waiting part that needs an undone part is discarded with the undo; approving it later is refused', async () => {
    await plant('prot')
    await w.callWeb(coraWeb, 'PUT', '/v1/brains/ul/protection/prot', { protected: true })
    const c = await w.call(cole.key, 'POST', '/v1/brains/ul/proposals', {
      title: 'New page and a link',
      ops: [create('newp'), { op: 'link', address: 'prot', kind: 'related', to: 'newp', reason: 'See.' }],
    })
    const id = (c.body.proposal as { id: string }).id
    const r = await undo(String(c.body.undo))
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.body.discarded, [1])
    const ops = (await w.call(cora.key, 'GET', `/v1/proposals/${id}`)).body.ops as Array<{ status: string }>
    assert.deepEqual(
      ops.map((o) => o.status),
      ['undone', 'undone'],
    )
    // A person makes another page at that address; the old link must not land on it.
    await plant('newp')
    const review = await w.callWeb(coraWeb, 'GET', `/v1/proposals/${id}/review`)
    const ok = await w.callWeb(coraWeb, 'POST', `/v1/proposals/${id}/approve`, {
      fingerprint: review.body.fingerprint,
      approve: [1],
    })
    assert.ok([400, 409].includes(ok.status), ok.text)
    assert.deepEqual(await links('prot'), [])
  })

  const link = (address: string, kind: string, to: string) =>
    byWeb({ op: 'link', address, kind, to, reason: 'Later.' })
  const unlink = (address: string, kind: string, to: string) =>
    byWeb({ op: 'unlink', address, kind, to, reason: 'Later.' })
  const editBoth = (title: string, addresses: string[]) =>
    w.call(cole.key, 'POST', '/v1/brains/ul/proposals', {
      title,
      ops: addresses.map((a) => ({
        op: 'edit',
        address: a,
        baseRevision: 1,
        body: `Agent words on ${a}.`,
        reason: 'R.',
      })),
    })

  it('V1: a link a person made later into another page of the change stays after the undo', async () => {
    await plant('p1')
    await plant('b1')
    await plant('r1', { links: [{ kind: 'related', to: 'p1' }] })
    const c = await editBoth('Edit p1 and b1', ['p1', 'b1'])
    assert.ok(c.body.undo, c.text)
    await link('r1', 'related', 'b1')
    const r = await undo(String(c.body.undo))
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(await links('r1'), ['related b1', 'related p1'])
  })

  it('V2: a link a person took away later does not come back because the change touched another page it points to', async () => {
    await plant('p3')
    await plant('b3')
    await plant('r3', {
      links: [
        { kind: 'related', to: 'p3' },
        { kind: 'related', to: 'b3' },
      ],
    })
    const c = await editBoth('Edit p3 and b3', ['p3', 'b3'])
    await unlink('r3', 'related', 'p3')
    const r = await undo(String(c.body.undo))
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(await links('r3'), ['related b3'])
  })

  it('V1–V2 by property: whatever people link and unlink later from other pages survives the undo', async () => {
    // A small seeded generator: the same sequences on every run, many shapes of change and later edit.
    let seed = 7
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    const kinds = ['related', 'depends-on', 'example-of']
    for (let round = 0; round < 6; round++) {
      const P = [0, 1, 2].map((i) => `prop${round}/p${i}`)
      const R = [0, 1, 2].map((i) => `prop${round}/r${i}`)
      for (const a of P) await plant(a)
      for (const a of R) {
        const out = P.filter(() => rnd(2) === 0).map((to) => ({ kind: kinds[rnd(3)] as string, to }))
        await plant(a, { links: out })
      }
      const touched = P.filter((_, i) => i === 0 || rnd(2) === 0)
      const ops: Json[] = touched.map((a) => ({
        op: 'edit',
        address: a,
        baseRevision: 1,
        body: `Agent words on ${a}.`,
        reason: 'R.',
      }))
      // Sometimes the change links one of its pages to another.
      if (touched.length > 1 && rnd(2) === 0)
        ops.push({ op: 'link', address: touched[0], kind: 'related', to: touched[1], reason: 'R.' })
      const before = Object.fromEntries(await Promise.all(P.map(async (a) => [a, await links(a)])))
      const c = await w.call(cole.key, 'POST', '/v1/brains/ul/proposals', { title: `Round ${round}`, ops })
      assert.ok(c.body.undo, c.text)
      for (let k = 0; k < 4; k++) {
        const from = R[rnd(3)] as string
        const to = P[rnd(3)] as string
        const kind = kinds[rnd(3)] as string
        const has = (await links(from)).includes(`${kind} ${to}`)
        await (has ? unlink(from, kind, to) : link(from, kind, to))
      }
      const later = Object.fromEntries(await Promise.all(R.map(async (a) => [a, await links(a)])))
      const r = await undo(String(c.body.undo))
      assert.equal(r.status, 200, r.text)
      for (const a of R) assert.deepEqual(await links(a), later[a], `round ${round}: ${a}`)
      for (const a of P) assert.deepEqual(await links(a), before[a], `round ${round}: ${a}`)
    }
  })

  it('V3: a proposal whose waiting parts went with the undo no longer waits, and the brain counts 0', async () => {
    await w.call(cora.key, 'POST', '/v1/brains', { slug: 'ul3', purpose: 'Undo, nothing waits.' })
    await w.member('ul3', cole.id, 'contributor')
    const e = await w.call(cole.key, 'POST', '/v1/brains/ul3/entries', {
      type: 'learning',
      title: 'S',
      content: 'S.',
    })
    const src = (e.body.receipt as { entryId: string }).entryId
    await w.callWeb(coraWeb, 'POST', '/v1/brains/ul3/wiki/changes', {
      op: 'create',
      address: 'guard',
      type: 'topic',
      title: 'Guard',
      summary: 'Guard.',
      body: 'Guard.',
    })
    await w.callWeb(coraWeb, 'PUT', '/v1/brains/ul3/protection/guard', { protected: true })
    const c = await w.call(cole.key, 'POST', '/v1/brains/ul3/proposals', {
      title: 'New page and a link',
      ops: [
        { ...create('fresh'), sources: [{ entryId: src }] },
        { op: 'link', address: 'guard', kind: 'related', to: 'fresh', reason: 'See.' },
      ],
    })
    const id = (c.body.proposal as { id: string }).id
    assert.equal((c.body.proposal as { status: string }).status, 'partially_applied')
    const stats = async () =>
      (
        (await w.call(cora.key, 'GET', '/v1/brains/ul3')).body.brain as {
          stats: { pendingProposals: number }
        }
      ).stats
    assert.equal((await stats()).pendingProposals, 1)
    const r = await w.callWeb(coraWeb, 'POST', `/v1/wiki/changes/${c.body.undo}/undo`, {})
    assert.equal(r.status, 200, r.text)
    const p = (await w.call(cora.key, 'GET', `/v1/proposals/${id}`)).body.proposal as { status: string }
    assert.notEqual(p.status, 'partially_applied')
    assert.notEqual(p.status, 'pending')
    assert.equal((await stats()).pendingProposals, 0)
  })

  const partOf = async (change: string, address: string) =>
    (
      (await w.callWeb(coraWeb, 'GET', `/v1/wiki/changes/${change}`)).body.parts as Array<{
        part: number
        address: string
      }>
    ).find((x) => x.address === address)?.part

  it('W1: undoing one part leaves the links of a part that stays (a link it added stays)', async () => {
    await plant('pa1')
    await plant('xa1')
    const c = await w.call(cole.key, 'POST', '/v1/brains/ul/proposals', {
      title: 'Edit and link',
      ops: [
        { op: 'edit', address: 'pa1', baseRevision: 1, body: 'Agent words.', reason: 'R.' },
        { op: 'link', address: 'xa1', kind: 'related', to: 'pa1', reason: 'R.' },
      ],
    })
    const id = String(c.body.undo)
    const r = await undo(id, { parts: [await partOf(id, 'pa1')] })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(await links('xa1'), ['related pa1'])
  })

  it('W1: undoing one part leaves the links of a part that stays (a link it took away stays away)', async () => {
    await plant('pd1')
    await plant('xd1', { links: [{ kind: 'related', to: 'pd1' }] })
    const c = await w.call(cole.key, 'POST', '/v1/brains/ul/proposals', {
      title: 'Edit and unlink',
      ops: [
        { op: 'edit', address: 'pd1', baseRevision: 1, body: 'Agent words.', reason: 'R.' },
        { op: 'unlink', address: 'xd1', kind: 'related', to: 'pd1', reason: 'R.' },
      ],
    })
    const id = String(c.body.undo)
    const r = await undo(id, { parts: [await partOf(id, 'pd1')] })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(await links('xd1'), [])
  })

  it('W2: a link a merge moved does not come back to the old page if a person took it away from the new one', async () => {
    await plant('sc1')
    await plant('tc1')
    await plant('xc1', { links: [{ kind: 'related', to: 'sc1' }] })
    const c = await w.call(cole.key, 'POST', '/v1/brains/ul/proposals', {
      title: 'Merge sc1 into tc1',
      ops: [
        {
          op: 'merge',
          address: 'tc1',
          from: 'sc1',
          body: 'Both.',
          dropSources: [],
          dropLinks: [],
          reason: 'Same.',
        },
      ],
    })
    assert.ok(c.body.undo, c.text)
    assert.deepEqual(await links('xc1'), ['related tc1'])
    await unlink('xc1', 'related', 'tc1')
    const r = await undo(String(c.body.undo))
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(await links('xc1'), [])
  })

  it('U4: an address another page took since is a conflict; overwrite does not take it from that page', async () => {
    const made = await w.call(writer, 'POST', '/v1/brains/ul/wiki/write', {
      title: 'Dd',
      ops: [create('dd')],
    })
    const un = await undo(String(made.body.undo), {}, writer)
    assert.equal(un.status, 200, un.text)
    await plant('dd', { title: 'Newcomer' })
    // The key's undo is a change of its own; undoing it would bring dd back over the newcomer.
    const back = (await w.call(cora.key, 'GET', '/v1/brains/ul/wiki/changes')).body.items as Array<{
      id: string
      title: string
    }>
    const undoChange = back.find((x) => /Undone: Written directly/.test(x.title))
    assert.ok(undoChange, JSON.stringify(back))
    for (const body of [{}, { overwrite: ['dd'] }]) {
      const r = await undo(undoChange.id, body)
      assert.equal(r.status, 409, r.text)
      assert.equal(r.body.error?.code, 'undo_conflict')
      assert.match(String(r.body.error?.message), /dd/)
      assert.equal(await holder('dd'), 'Newcomer')
    }
  })
})
