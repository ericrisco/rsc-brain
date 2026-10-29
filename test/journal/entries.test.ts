// Spec B1, the journal: saving entries, topics, duplicates, request keys, privacy, sessions, stamped
// references and corrections — over HTTP against a real PostgreSQL.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { SECRET_MARK } from '../../src/privacy/redact.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Receipt = {
  entryId: string
  revision: number
  deduplicated: boolean
  repeatCount: number
  redactions: number
  topicNote?: string
  similar: { entryId: string; title: string; why: string }[]
}

const GITHUB = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'

describe('the journal', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string; email: string }
  let ana: { id: string; key: string }
  let reader: { id: string; key: string }
  let bob: { id: string; key: string }
  let factory: { id: string; key: string }

  const save = async (key: string, body: Record<string, unknown>, slug = 'yt') => {
    const r = await w.call(key, 'POST', `/v1/brains/${slug}/entries`, body)
    return { ...r, receipt: r.body.receipt as Receipt }
  }
  const entry = async (key: string, id: string, history = false) =>
    (await w.call(key, 'GET', `/v1/entries/${id}${history ? '?history=1' : ''}`)).body

  before(async () => {
    w = await world()
    const e = await w.person('Eric', { isAdmin: true })
    eric = {
      ...e,
      email: (await w.db.one<{ email: string }>('SELECT email FROM accounts WHERE id = $1', [e.id]))
        ?.email as string,
    }
    ana = await w.person('Ana')
    reader = await w.person('Reader')
    bob = await w.person('Bob')
    factory = await w.service('RSC Factory')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'yt', purpose: 'Our channel.' })
    await w.member('yt', ana.id, 'contributor')
    await w.member('yt', reader.id, 'reader')
    await w.member('yt', bob.id, 'contributor')
    await w.member('yt', factory.id, 'contributor')
  })
  after(async () => w.close())

  it('CA1: a contributor saves an entry and gets a receipt; it shows in the session and the activity', async () => {
    const r = await save(ana.key, {
      type: 'decision',
      title: 'Hooks under 5s',
      content: 'We cut hooks to 5s because retention dropped.',
    })
    assert.equal(r.status, 201)
    assert.equal(r.receipt.revision, 1)
    assert.match(r.receipt.entryId, /^ent_[0-9a-f]{12}$/)
    const e = (await entry(ana.key, r.receipt.entryId)).entry as { sessionId: string; type: string }
    assert.equal(e.type, 'decision')
    const inSession = await w.call(ana.key, 'GET', `/v1/brains/yt/entries?session=${e.sessionId}`)
    assert.ok((inSession.body.items as { id: string }[]).some((x) => x.id === r.receipt.entryId))
    const ev = await w.db.one("SELECT kind FROM events WHERE target_id = $1 AND kind = 'entry.saved'", [
      r.receipt.entryId,
    ])
    assert.ok(ev)
  })

  it('CA2: saving the same topic revises the one entry and keeps the history', async () => {
    const a = await save(ana.key, {
      type: 'learning',
      title: 'Intro length',
      content: 'Intros of 30s work.',
      topic: 'style/intro-length',
    })
    const b = await save(eric.key, {
      type: 'learning',
      title: 'Intro length',
      content: 'Intros of 20s work better.',
      topic: 'style/intro-length',
    })
    assert.equal(b.receipt.entryId, a.receipt.entryId)
    assert.equal(b.receipt.revision, 2)
    const n = await w.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM entries WHERE topic = 'style/intro-length'",
    )
    assert.equal(n?.n, 1)
    const h = (await entry(ana.key, a.receipt.entryId, true)).history as {
      revision: number
      content: string
    }[]
    assert.deepEqual(
      h.map((x) => [x.revision, x.content]),
      [
        [1, 'Intros of 30s work.'],
        [2, 'Intros of 20s work better.'],
      ],
    )
  })

  it('CA26: a topic revision replaces the whole entry, it does not merge fields', async () => {
    const a = await save(ana.key, {
      type: 'fact',
      title: 'Voice',
      content: 'Bella.',
      topic: 'voices/narrator',
      tags: ['a', 'b'],
    })
    await save(ana.key, {
      type: 'fact',
      title: 'Voice',
      content: 'Bella v2.',
      topic: 'voices/narrator',
      tags: ['c'],
    })
    const e = (await entry(ana.key, a.receipt.entryId)).entry as { tags: string[] }
    assert.deepEqual(e.tags, ['c'])
  })

  it('CA3: suggesting a topic offers the existing similar ones', async () => {
    const r = await w.call(ana.key, 'POST', '/v1/brains/yt/topics/suggest', { title: 'Intro length rule' })
    assert.equal(r.body.suggested, 'intro-length-rule')
    assert.ok((r.body.similar as { topic: string }[]).some((s) => s.topic === 'style/intro-length'))
  })

  it('a malformed topic is refused with a suggestion', async () => {
    const r = await save(ana.key, { type: 'note', title: 'x', content: 'y', topic: 'Style/Intro Length' })
    assert.equal(r.status, 400)
    assert.match(r.body.error?.howToProceed ?? '', /style\/intro-length/)
  })

  it('CA4: the same account repeating itself within 15 minutes counts, another account writes its own', async () => {
    const body = {
      type: 'note',
      title: 'Thumbnail colours',
      content: 'Yellow text works on dark backgrounds.',
    }
    const a = await save(ana.key, body)
    w.advance(5 * 60_000)
    const b = await save(ana.key, {
      ...body,
      title: '  thumbnail   COLOURS ',
      content: 'yellow TEXT works on dark   backgrounds.',
    })
    assert.equal(b.receipt.entryId, a.receipt.entryId)
    assert.equal(b.receipt.deduplicated, true)
    assert.equal(b.receipt.repeatCount, 2)
    const c = await save(eric.key, body)
    assert.notEqual(c.receipt.entryId, a.receipt.entryId)
    w.advance(16 * 60_000)
    const d = await save(ana.key, body)
    assert.notEqual(d.receipt.entryId, a.receipt.entryId)
  })

  it('CA5: retrying with the same request key returns the same receipt and writes nothing', async () => {
    const body = {
      type: 'step',
      title: 'Rendered audio',
      content: 'audio.mp3 rendered with voice Bella.',
      requestKey: 'req-1',
    }
    const a = await save(ana.key, body)
    const before = await w.db.one<{ n: number }>('SELECT count(*)::int AS n FROM entries')
    const b = await save(ana.key, body)
    assert.deepEqual(b.receipt, a.receipt)
    const after1 = await w.db.one<{ n: number }>('SELECT count(*)::int AS n FROM entries')
    assert.equal(after1?.n, before?.n)
    const c = await save(ana.key, { ...body, content: 'something else entirely' })
    assert.equal(c.status, 409)
    assert.equal(c.body.error?.code, 'request_key_reused')
  })

  it('CA27: two requests that differ only in a secret are the same request once redacted', async () => {
    const a = await save(ana.key, {
      type: 'note',
      title: 'Key',
      content: `use ${GITHUB} here`,
      requestKey: 'req-secret',
    })
    const other = GITHUB.replace('Ab', 'Zz')
    const b = await save(ana.key, {
      type: 'note',
      title: 'Key',
      content: `use ${other} here`,
      requestKey: 'req-secret',
    })
    assert.equal(b.status, 201)
    assert.deepEqual(b.receipt, a.receipt)
  })

  it('CA6 and CA7: private text and secrets are never stored, not even in the history', async () => {
    const r = await save(ana.key, {
      type: 'note',
      title: 'Contact',
      content: `Ship to <private>Calle Mayor 1</private>. Token ${GITHUB}.`,
      refs: [`https://x.com?k=${GITHUB}`],
    })
    assert.equal(r.receipt.redactions, 3)
    const e = (await entry(ana.key, r.receipt.entryId, true)) as {
      entry: { content: string; tags: string[] }
      history: { content: string }[]
    }
    assert.equal(e.entry.content, `Ship to [private removed]. Token ${SECRET_MARK}.`)
    const all = JSON.stringify(
      await w.db.query('SELECT e.*, r.* FROM entries e JOIN entry_revisions r ON r.entry_id = e.id'),
    )
    assert.ok(!all.includes('Calle Mayor'))
    assert.ok(!all.includes(GITHUB))
  })

  it('CA28 (entries part): request keys, events and receipts hold no secret either', async () => {
    await save(ana.key, { type: 'note', title: `Title ${GITHUB}`, content: 'x', requestKey: 'req-t' })
    for (const table of ['request_keys', 'events', 'entry_revisions', 'entries']) {
      const dump = JSON.stringify(await w.db.query(`SELECT * FROM ${table}`))
      assert.ok(!dump.includes(GITHUB), table)
    }
  })

  it('CA8: closing a session with a summary', async () => {
    const s = (await w.call(ana.key, 'POST', '/v1/brains/yt/sessions', { purpose: 'Edit video 12' })).body
      .session as { id: string }
    for (const t of ['one', 'two', 'three']) {
      await save(ana.key, { type: 'note', title: `Step ${t}`, content: `Did ${t}.`, sessionId: s.id })
    }
    const sum = await w.call(ana.key, 'POST', `/v1/sessions/${s.id}/summary`, {
      content: 'Goal: edit. Done: three steps.',
    })
    assert.equal(sum.status, 201)
    const id = (sum.body.receipt as Receipt).entryId
    const list = await w.call(ana.key, 'GET', '/v1/brains/yt/sessions')
    const got = (list.body.items as { id: string; status: string; summaryEntryId: string }[]).find(
      (x) => x.id === s.id,
    )
    assert.deepEqual([got?.status, got?.summaryEntryId], ['closed', id])
    assert.equal(((await entry(ana.key, id)).entry as { type: string }).type, 'summary')
    const again = await w.call(ana.key, 'POST', `/v1/sessions/${s.id}/summary`, { content: 'again' })
    assert.equal(again.status, 409)
  })

  it('CA9: a session idle for 24 hours closes itself without a summary', async () => {
    const s = (await w.call(ana.key, 'POST', '/v1/brains/yt/sessions', { purpose: 'forgotten one' })).body
      .session as { id: string }
    w.advance(24 * 3_600_000 + 1)
    const list = await w.call(ana.key, 'GET', '/v1/brains/yt/sessions?limit=200')
    const got = (list.body.items as { id: string; status: string }[]).find((x) => x.id === s.id)
    assert.equal(got?.status, 'closed_no_summary')
    // Its followers learn it closed (spec B5 «Flujo de eventos»: «sesión cerrada»), by the system.
    const ev = await w.db.query(
      "SELECT account_id, credential_id, label FROM events WHERE kind = 'session.closed' AND target_id = $1",
      [s.id],
    )
    assert.deepEqual(ev, [{ account_id: null, credential_id: null, label: 'idle for 24 hours' }])
  })

  it("without a session, entries go to the key's implicit session of the day", async () => {
    const a = await save(reader.key === ana.key ? ana.key : ana.key, {
      type: 'note',
      title: 'Implicit A',
      content: 'aaa aaa',
    })
    const b = await save(ana.key, { type: 'note', title: 'Implicit B', content: 'bbb bbb' })
    const sa = ((await entry(ana.key, a.receipt.entryId)).entry as { sessionId: string }).sessionId
    const sb = ((await entry(ana.key, b.receipt.entryId)).entry as { sessionId: string }).sessionId
    assert.equal(sa, sb)
    w.advance(24 * 3_600_000)
    const c = await save(ana.key, { type: 'note', title: 'Implicit C', content: 'ccc ccc' })
    const sc = ((await entry(ana.key, c.receipt.entryId)).entry as { sessionId: string }).sessionId
    assert.notEqual(sc, sa)
  })

  it('CA10 and CA29: a short key writes into the session its service opened; the reference is stamped', async () => {
    const k = (
      await w.call(factory.key, 'POST', '/v1/keys/short', {
        writeBrain: 'yt',
        ref: 'run r_x, step 3',
        agent: 'narrator',
        ttlMinutes: 60,
      })
    ).body.key as { id: string; secret: string }
    const s = (
      await w.call(factory.key, 'POST', '/v1/brains/yt/sessions', { purpose: 'Narrate', forKey: k.id })
    ).body.session as { id: string; ref: string }
    assert.equal(s.ref, 'run r_x, step 3')
    const one = await save(k.secret, {
      type: 'step',
      title: 'Narrated',
      content: 'Audio done with Bella, 3 takes.',
    })
    const e1 = (await entry(k.secret, one.receipt.entryId)).entry as { sessionId: string; ref: string }
    assert.deepEqual([e1.sessionId, e1.ref], [s.id, 'run r_x, step 3'])
    const end = await w.call(factory.key, 'POST', `/v1/sessions/${s.id}/end`)
    assert.equal((end.body.session as { status: string }).status, 'closed_no_summary')
    const two = await save(k.secret, {
      type: 'step',
      title: 'Retake',
      content: 'One more take after the session closed.',
    })
    const byRef = await w.call(
      eric.key,
      'GET',
      `/v1/brains/yt/entries?ref=${encodeURIComponent('run r_x, step 3')}`,
    )
    assert.deepEqual(
      (byRef.body.items as { id: string }[]).map((x) => x.id).sort(),
      [one.receipt.entryId, two.receipt.entryId].sort(),
    )
  })

  it('CA24c: a reference typed by hand when opening a session stamps nothing', async () => {
    await w.call(ana.key, 'POST', '/v1/brains/yt/sessions', { purpose: 'fake', ref: 'run r_fake, step 1' })
    await save(ana.key, { type: 'note', title: 'Pretending', content: 'Not a factory step.' })
    const byRef = await w.call(
      eric.key,
      'GET',
      `/v1/brains/yt/entries?ref=${encodeURIComponent('run r_fake, step 1')}`,
    )
    assert.deepEqual(byRef.body.items, [])
  })

  it('CA24: no agent key writes a correction; a service main key relays one for a contributor', async () => {
    const asAgent = await save(ana.key, { type: 'correction', title: 'No', content: 'Do it my way.' })
    assert.equal(asAgent.status, 400)
    assert.match(asAgent.body.error?.howToProceed ?? '', /learning/)
    const k = (
      await w.call(factory.key, 'POST', '/v1/keys/short', {
        writeBrain: 'yt',
        ref: 'r',
        onBehalf: eric.email,
        ttlMinutes: 5,
      })
    ).body.key as { secret: string }
    const viaShort = await w.call(k.secret, 'POST', '/v1/brains/yt/corrections/relay', {
      onBehalf: eric.email,
      title: 'x',
      content: 'y',
    })
    assert.equal(viaShort.status, 403)
    const forReader = await w.call(factory.key, 'POST', '/v1/brains/yt/corrections/relay', {
      onBehalf: (await w.db.one<{ email: string }>('SELECT email FROM accounts WHERE id = $1', [reader.id]))
        ?.email,
      title: 'x',
      content: 'y',
    })
    assert.equal(forReader.status, 403)
    const ok = await w.call(factory.key, 'POST', '/v1/brains/yt/corrections/relay', {
      onBehalf: eric.email,
      title: 'The hook is too slow',
      content: 'Returned at the gate: the hook is too slow.',
      appliesTo: 'narrator',
    })
    assert.equal(ok.status, 201)
    const e = (await entry(eric.key, (ok.body.receipt as Receipt).entryId)).entry as {
      type: string
      topic: string | null
      onBehalfId: string
      appliesTo: string
    }
    assert.deepEqual([e.type, e.topic, e.onBehalfId, e.appliesTo], ['correction', null, eric.id, 'narrator'])
  })

  it('CA14 (receipt part): similar entries are listed without meaning search', async () => {
    await save(ana.key, {
      type: 'learning',
      title: 'Intros and retention',
      content: 'intros of 30s work best for retention',
      topic: 'style/intros',
    })
    const r = await save(ana.key, {
      type: 'learning',
      title: 'Long intros',
      content: 'intros longer than 30s hurt retention',
    })
    assert.ok(r.receipt.similar.some((s) => s.title === 'Intros and retention' && s.why === 'words'))
  })

  it('CA25: saving to a topic whose entry was forgotten creates a new entry and says so', async () => {
    const a = await save(ana.key, { type: 'fact', title: 'Old', content: 'old voice', topic: 'voices/old' })
    await w.db.query("UPDATE entries SET state = 'forgotten' WHERE id = $1", [a.receipt.entryId])
    const b = await save(ana.key, { type: 'fact', title: 'New', content: 'new voice', topic: 'voices/old' })
    assert.notEqual(b.receipt.entryId, a.receipt.entryId)
    assert.match(b.receipt.topicNote ?? '', /forgotten/)
  })

  it('CA22 and errors: limits, types and permissions say what to do', async () => {
    const long = await save(ana.key, { type: 'note', title: 't', content: 'x'.repeat(32_001) })
    assert.equal(long.status, 400)
    assert.match(long.body.error?.howToProceed ?? '', /Split/)
    const type = await save(ana.key, { type: 'rant', title: 't', content: 'c' })
    assert.match(type.body.error?.howToProceed ?? '', /decision, learning/)
    const ro = await save(reader.key, { type: 'note', title: 't', content: 'c' })
    assert.equal(ro.status, 403)
    assert.match(ro.body.error?.howToProceed ?? '', /contributor/)
  })

  it('CA18: an archived brain refuses writes and still reads', async () => {
    await w.call(eric.key, 'POST', '/v1/brains/yt/archive')
    const r = await save(ana.key, { type: 'note', title: 't', content: 'c' })
    assert.equal(r.status, 403)
    assert.match(r.body.error?.howToProceed ?? '', /unarchive/)
    assert.equal((await w.call(ana.key, 'GET', '/v1/brains/yt/entries')).status, 200)
    await w.call(eric.key, 'POST', '/v1/brains/yt/unarchive')
  })

  it('CA19: entries of a brain I am not in answer like a brain that does not exist', async () => {
    const outsider = await w.person('Outsider')
    const a = await w.call(outsider.key, 'POST', '/v1/brains/yt/entries', {
      type: 'note',
      title: 't',
      content: 'c',
    })
    const b = await w.call(outsider.key, 'POST', '/v1/brains/nope/entries', {
      type: 'note',
      title: 't',
      content: 'c',
    })
    assert.equal(a.text, b.text)
    const someEntry = await w.db.one<{ id: string }>(
      "SELECT id FROM entries WHERE brain_id = (SELECT id FROM brains WHERE slug = 'yt') LIMIT 1",
    )
    const c = await w.call(outsider.key, 'GET', `/v1/entries/${someEntry?.id}`)
    const d = await w.call(outsider.key, 'GET', '/v1/entries/ent_000000000000')
    assert.equal(c.text, d.text)
  })

  it('listings page through with a cursor and give the total', async () => {
    const first = await w.call(eric.key, 'GET', '/v1/brains/yt/entries?limit=3')
    assert.equal((first.body.items as unknown[]).length, 3)
    const total = first.body.total as number
    let seen = 3
    let next = first.body.next as string | null
    while (next) {
      const p = await w.call(eric.key, 'GET', `/v1/brains/yt/entries?limit=3&cursor=${next}`)
      seen += (p.body.items as unknown[]).length
      next = p.body.next as string | null
    }
    assert.equal(seen, total)
    assert.equal((await w.call(eric.key, 'GET', '/v1/brains/yt/entries?cursor=garbage')).status, 400)
  })

  it('review: session purpose and reference are redacted, also in the activity', async () => {
    const s = (
      await w.call(ana.key, 'POST', '/v1/brains/yt/sessions', {
        purpose: `deploy with ${GITHUB}`,
        ref: `job ${GITHUB}`,
      })
    ).body.session as { id: string; purpose: string; ref: string }
    assert.ok(!s.purpose.includes(GITHUB) && !s.ref.includes(GITHUB))
    for (const t of ['sessions', 'events']) {
      assert.ok(!JSON.stringify(await w.db.query(`SELECT * FROM ${t}`)).includes(GITHUB), t)
    }
  })

  it('review: request keys are stored as hashes, never as given', async () => {
    await save(ana.key, { type: 'note', title: 'K', content: 'keyed', requestKey: GITHUB })
    assert.ok(!JSON.stringify(await w.db.query('SELECT * FROM request_keys')).includes(GITHUB))
  })

  it('review: a short key reference is redacted when the key is minted', async () => {
    const k = (
      await w.call(factory.key, 'POST', '/v1/keys/short', {
        writeBrain: 'yt',
        ref: `run ${GITHUB}`,
        ttlMinutes: 5,
      })
    ).body.key as { secret: string }
    const me = (await w.call(k.secret, 'GET', '/v1/me')).body.key as { ref: string }
    assert.ok(!me.ref.includes(GITHUB))
  })

  it('review: a revision by someone else neither borrows nor takes away a job reference', async () => {
    const k = (
      await w.call(factory.key, 'POST', '/v1/keys/short', {
        writeBrain: 'yt',
        ref: 'run r_t, step 1',
        ttlMinutes: 30,
      })
    ).body.key as { secret: string }
    await save(k.secret, {
      type: 'step',
      title: 'Narration',
      content: 'Narrated by the step.',
      topic: 'steps/narration',
    })
    await save(ana.key, {
      type: 'step',
      title: 'Narration',
      content: 'planted by ana',
      topic: 'steps/narration',
    })
    const byRef = (
      await w.call(eric.key, 'GET', `/v1/brains/yt/entries?ref=${encodeURIComponent('run r_t, step 1')}`)
    ).body.items as { content: string; revision: number; ref: string }[]
    assert.equal(byRef.length, 1)
    assert.deepEqual([byRef[0]?.content, byRef[0]?.revision], ['Narrated by the step.', 1])
    const stamped = await w.db.one("SELECT stamped_ref FROM entries WHERE topic = 'steps/narration'")
    assert.equal(stamped?.stamped_ref, null)
  })

  it('review: relayed corrections for two people, or after a learning, stay separate', async () => {
    const relay = (onBehalf: string) =>
      w.call(factory.key, 'POST', '/v1/brains/yt/corrections/relay', {
        onBehalf,
        title: 'Hook slow',
        content: 'The hook is too slow.',
      })
    const anaEmail = (await w.db.one<{ email: string }>('SELECT email FROM accounts WHERE id = $1', [ana.id]))
      ?.email as string
    const a = (await relay(anaEmail)).body.receipt as Receipt
    const b = (await relay(eric.email)).body.receipt as Receipt
    assert.notEqual(a.entryId, b.entryId)
    const k = (
      await w.call(factory.key, 'POST', '/v1/keys/short', {
        writeBrain: 'yt',
        ref: 'r-learn',
        ttlMinutes: 30,
      })
    ).body.key as { secret: string }
    const l = await save(k.secret, {
      type: 'learning',
      title: 'Intro long',
      content: 'Long intro loses retention.',
    })
    const c = (
      await w.call(factory.key, 'POST', '/v1/brains/yt/corrections/relay', {
        onBehalf: eric.email,
        title: 'Intro long',
        content: 'Long intro loses retention.',
      })
    ).body.receipt as Receipt
    assert.notEqual(c.entryId, l.receipt.entryId)
    assert.equal(c.deduplicated, false)
  })

  it('review: two jobs saying the same thing keep one entry each', async () => {
    const mint = async (ref: string) =>
      (
        (await w.call(factory.key, 'POST', '/v1/keys/short', { writeBrain: 'yt', ref, ttlMinutes: 30 })).body
          .key as { secret: string }
      ).secret
    const ka = await mint('run A')
    const kb = await mint('run B')
    const a = await save(ka, { type: 'step', title: 'Done', content: 'Narration done.' })
    const b = await save(kb, { type: 'step', title: 'Done', content: 'Narration done.' })
    assert.notEqual(a.receipt.entryId, b.receipt.entryId)
  })

  it('review: two sessions closed with the same words each get their own summary', async () => {
    const open = async () =>
      (
        (await w.call(ana.key, 'POST', '/v1/brains/yt/sessions', { purpose: 'p' })).body.session as {
          id: string
        }
      ).id
    const s1 = await open()
    const r1 = (await w.call(ana.key, 'POST', `/v1/sessions/${s1}/summary`, { content: 'Nothing pending.' }))
      .body.receipt as Receipt
    const s2 = await open()
    const r2 = (
      await w.call(ana.key, 'POST', `/v1/sessions/${s2}/summary`, { content: 'nothing   pending.' })
    ).body.receipt as Receipt
    assert.notEqual(r1.entryId, r2.entryId)
    const e2 = (await entry(ana.key, r2.entryId)).entry as { sessionId: string }
    assert.equal(e2.sessionId, s2)
  })

  it('review: retrying a summary with its request key returns the same receipt', async () => {
    const s = (
      (await w.call(ana.key, 'POST', '/v1/brains/yt/sessions', { purpose: 'retry' })).body.session as {
        id: string
      }
    ).id
    const body = { content: 'Goal reached.', requestKey: 'sum-retry' }
    const a = await w.call(ana.key, 'POST', `/v1/sessions/${s}/summary`, body)
    const b = await w.call(ana.key, 'POST', `/v1/sessions/${s}/summary`, body)
    assert.equal(b.status, 201)
    assert.equal(b.text, a.text)
  })

  it('review: identical saves at once, from a key with its own open session, count once', async () => {
    const s = (
      (await w.call(bob.key, 'POST', '/v1/brains/yt/sessions', { purpose: 'storm' })).body.session as {
        id: string
      }
    ).id
    const body = { type: 'note', title: 'Storm', content: 'same thing ten times' }
    const rs = await Promise.all(Array.from({ length: 10 }, () => save(bob.key, body)))
    const ids = new Set(rs.map((r) => r.receipt.entryId))
    assert.equal(ids.size, 1)
    const e = (await entry(bob.key, [...ids][0] as string)).entry as {
      sessionId: string
      repeatCount: number
    }
    assert.deepEqual([e.sessionId, e.repeatCount], [s, 10])
  })

  it('review: writes racing a summary never land in the closed session', async () => {
    for (let round = 0; round < 5; round += 1) {
      const s = (
        (await w.call(bob.key, 'POST', '/v1/brains/yt/sessions', { purpose: `race ${round}` })).body
          .session as { id: string }
      ).id
      const writes = Array.from({ length: 6 }, (_, i) =>
        save(bob.key, { type: 'note', title: `r${round}w${i}`, content: `race ${round} ${i}` }),
      )
      const sum = w.call(bob.key, 'POST', `/v1/sessions/${s}/summary`, { content: `summary ${round}` })
      await Promise.all([...writes, sum])
      const closedAt = await w.db.one<{ closed_at: Date }>('SELECT closed_at FROM sessions WHERE id = $1', [
        s,
      ])
      const late = await w.db.query(
        'SELECT id FROM entries WHERE session_id = $1 AND created_at > $2 AND type <> $3',
        [s, closedAt?.closed_at, 'summary'],
      )
      assert.deepEqual(late, [])
    }
  })

  it('review: a read-only key cannot close sessions', async () => {
    const ro = await w.token(ana.id, { perm: 'read' })
    const s = (
      (await w.call(ana.key, 'POST', '/v1/brains/yt/sessions', { purpose: 'ro' })).body.session as {
        id: string
      }
    ).id
    assert.equal((await w.call(ro, 'POST', `/v1/sessions/${s}/end`)).status, 403)
  })

  it('review: one open session per short key, even when opened twice at once', async () => {
    const k = (
      await w.call(factory.key, 'POST', '/v1/keys/short', { writeBrain: 'yt', ref: 'twice', ttlMinutes: 30 })
    ).body.key as { id: string }
    const rs = await Promise.all(
      [1, 2].map(() => w.call(factory.key, 'POST', '/v1/brains/yt/sessions', { forKey: k.id })),
    )
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409])
  })

  it('review: text still has to fit once secrets become marks', async () => {
    // 31 998 characters fit; the 10-character password becomes a 17-character mark and no longer does.
    const content = `${'y'.repeat(31_975)} https://u:p4ssw0rd99@h`
    assert.equal(content.length, 31_998)
    const r = await save(ana.key, { type: 'note', title: 't', content })
    assert.equal(r.status, 400)
    assert.match(String((r.body.error as { message: string }).message), /Once secrets are replaced/)
  })
})
