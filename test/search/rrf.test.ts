// Spec v0.6 CA14, CA15: with meaning search on, words and meaning are mixed by reciprocal rank fusion (k = 60):
// a result found both ways goes before one found one way only at the same position, even one that scores more
// by words; a superseded page still goes after the page that replaced it. On the three databases (with pgvector,
// closeness is its operator's).
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { limitSearchFeatures, searchFeatures } from '../../src/db/extensions.ts'
import { embedRound } from '../../src/domain/meaning.ts'
import { RRF_K, rrf } from '../../src/domain/search.ts'
import { type FakeProvider, fakeProvider } from '../helpers/meaning.ts'
import { skipPg, TEST_SEARCH } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Hit = { address?: string; why: string; reason: string }

describe('reciprocal rank fusion', () => {
  it('sums 1/(60 + position) over the lists a result is in', () => {
    assert.equal(RRF_K, 60)
    assert.equal(rrf([1]), 1 / 61)
    assert.equal(rrf([1, 1]), 2 / 61)
    // In both lists, second in each: more than first in one only.
    assert.ok(rrf([2, 2]) > rrf([1]))
    assert.ok(rrf([2, 1]) > rrf([1]))
  })
})

describe('words and meaning mixed by RRF (v0.6)', { skip: skipPg }, () => {
  let w: World
  let test: FakeProvider
  let eric: { id: string; key: string }
  let web: string

  const page = async (address: string, title: string, body: string) => {
    const r = await w.callWeb(web, 'POST', '/v1/brains/mx/wiki/changes', {
      op: 'create',
      address,
      type: 'topic',
      title,
      summary: '',
      body,
    })
    assert.equal(r.status, 201, r.text)
    w.advance(60_000)
  }
  const find = async (q: string, extra = '') => {
    const r = await w.call(
      eric.key,
      'GET',
      `/v1/search?brains=mx&in=pages&q=${encodeURIComponent(q)}${extra}`,
    )
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.meaning, 'on', r.text)
    return r.body.items as Hit[]
  }
  const process = async () => {
    for (let i = 0; i < 10; i++) await embedRound(w.db, { test }, w.clock)
  }

  before(async () => {
    test = fakeProvider('test', 'fake-1')
    w = await world({ meaning: { test } })
    eric = await w.person('Eric')
    const admin = await w.person('Admin', { isAdmin: true })
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'mx', purpose: 'Mixing.' })
    web = await w.web(eric.id)
    const on = await w.callWeb(await w.web(admin.id), 'PUT', '/v1/admin/meaning', {
      provider: 'test',
      accept: true,
    })
    assert.equal(on.status, 200, on.text)
    // Found both ways: the word once, and close in meaning.
    await page('both', 'Both', 'Retention of a video, said once.')
    // Found by meaning only: no word of the search, the same concept.
    await page('meaning-only', 'Stay', 'How long people stay before the drop.')
    await process()
    // Found by words only, and the most by words: written after the vectors were made.
    await page('words-only', 'Retention', 'Retention retention retention: retention, retention.')
  })
  after(async () => w.close())

  it('CA14: a result in both lists goes before the first of one list only', async () => {
    const got = await find('retention')
    const at = (a: string) => got.findIndex((h) => h.address === a)
    assert.equal(got[0]?.address, 'both', JSON.stringify(got))
    assert.ok(at('words-only') > 0 && at('meaning-only') > 0, JSON.stringify(got))
    assert.equal(got[0]?.reason, 'matched by words and meaning')
    assert.equal(got.find((h) => h.address === 'meaning-only')?.why, 'meaning')
  })

  // Owner's call on review of feat/v06 (3): the mixed score orders as it is, without bands; being current and
  // being newer only break exact ties.
  it('the RRF score orders without bands: first by words and older goes before fifth by words and newer', async () => {
    for (const [i, n] of [5, 4, 3, 2, 1].entries()) {
      // The same length each; the fewer times the word, the lower by words, and each newer than the last.
      await page(`band-${i}`, 'Note', `${'retention '.repeat(n)}${'filler '.repeat(6 - n)}`.trim())
    }
    const all = (await find('retention')).map((h) => h.address).filter((a) => a?.startsWith('band-'))
    assert.deepEqual(all, ['band-0', 'band-1', 'band-2', 'band-3', 'band-4'])
  })

  // Review of feat/v06 (5): when pgvector's operator fails (here a stored vector it refuses), closeness is worked
  // out the other way, and meaning search stays on.
  it('pgvector failing: the closeness is the sum of products, and meaning stays on', async (t) => {
    if (!(await searchFeatures(w.db)).vector) return t.skip('pgvector is not used on this database')
    const p = await w.db.one<{ id: string; brain_id: string }>(
      "SELECT id, brain_id FROM pages WHERE address = 'words-only'",
    )
    const nan = [Number.NaN, ...new Array(31).fill(0)]
    await w.db.query(
      `INSERT INTO meaning_vectors (kind, target_id, brain_id, provider, model, text_hash, vec, updated_at)
       VALUES ('page', $1, $2, 'test', 'fake-1', 'not this text', $3::real[], now())`,
      [p?.id, p?.brain_id, nan],
    )
    try {
      const got = await find('retention')
      assert.ok(
        got.some((h) => h.address === 'meaning-only' && h.why === 'meaning'),
        JSON.stringify(got),
      )
    } finally {
      await w.db.query("DELETE FROM meaning_vectors WHERE text_hash = 'not this text'")
    }
  })

  it('closeness is the same with pgvector as without it', async () => {
    const order = async () => (await find('retention')).map((h) => `${h.address}:${h.why}`)
    const withAll = await order()
    limitSearchFeatures(w.db, { vector: false })
    try {
      assert.deepEqual(await order(), withAll)
    } finally {
      limitSearchFeatures(w.db, TEST_SEARCH === 'bm25' ? { vector: false } : {})
    }
  })

  it('CA15: with meaning on, a superseded page still goes after the page that replaced it', async () => {
    await page('old-retention', 'Retention retention', 'Retention retention retention retention.')
    await page('new-retention', 'Audience', 'People stay.')
    const r = await w.callWeb(web, 'POST', '/v1/brains/mx/wiki/changes', {
      op: 'status',
      address: 'old-retention',
      status: 'superseded',
      supersededBy: 'new-retention',
      reason: 'Replaced.',
    })
    assert.equal(r.status < 300, true, r.text)
    await process()
    const got = (await find('retention', '&include=superseded')).map((h) => h.address)
    assert.ok(got.includes('new-retention') && got.includes('old-retention'), got.join(', '))
    assert.ok(got.indexOf('new-retention') < got.indexOf('old-retention'), got.join(', '))
  })
})
