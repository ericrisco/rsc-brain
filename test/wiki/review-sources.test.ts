// Review of PR26 (spec B6 «Propuestas», B5 «Rastro»): a proposal names its source entries by title in the
// review itself, as a wiki page does, so the web never opens each entry to name it. Opening an entry is
// a read (it goes to the trail and to the live events); looking at a proposal is not. A forgotten entry
// keeps its place but its words only for a curator, and a purged one for nobody.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type SourceEntry = { id: string; title: string | null; state: string }

describe('a proposal review names its source entries', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let ana: { id: string; key: string }
  let factory: { id: string; key: string }
  let ericWeb: string
  let anaWeb: string
  let id: string
  let e: [string, string, string]

  const save = async (title: string) =>
    (
      (
        await w.call(eric.key, 'POST', '/v1/brains/rs/entries', {
          type: 'learning',
          title,
          content: `About ${title}.`,
        })
      ).body.receipt as { entryId: string }
    ).entryId
  const review = async (session: string) => {
    const r = await w.callWeb(session, 'GET', `/v1/proposals/${id}/review`)
    assert.equal(r.status, 200, r.text)
    return r.body as { sourceEntries: SourceEntry[] }
  }
  const reads = async () =>
    Number(
      (
        await w.db.one(
          `SELECT (SELECT count(*) FROM trail WHERE kind = 'read') + (SELECT count(*) FROM events WHERE kind = 'read') AS n`,
        )
      )?.n,
    )

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    ana = await w.person('Ana')
    factory = await w.service('RSC Factory')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'rs', purpose: 'Sources.' })
    await w.member('rs', ana.id, 'contributor')
    await w.member('rs', factory.id, 'contributor')
    ericWeb = await w.web(eric.id)
    anaWeb = await w.web(ana.id)
    e = [await save('The hook goes first'), await save('An old number'), await save('A secret')]
    const r = await w.call(factory.key, 'POST', '/v1/brains/rs/proposals', {
      title: 'P',
      ops: [
        {
          op: 'create',
          address: 'a/one',
          type: 'topic',
          title: 'One',
          summary: 'One.',
          body: 'One.',
          sources: [{ entryId: e[0] }, { entryId: e[1] }, { entryId: e[2] }, { url: 'https://x.test/a' }],
          reason: 'The journal says so.',
        },
      ],
    })
    assert.equal(r.status, 201, r.text)
    id = (r.body.proposal as { id: string }).id
    assert.equal(
      (await w.call(eric.key, 'POST', `/v1/entries/${e[1]}/forget`, { reason: 'wrong' })).status,
      200,
    )
    await w.db.query(`UPDATE entries SET state = 'purged' WHERE id = $1`, [e[2]])
  })
  after(async () => w.close())

  it('a curator sees the title of an active and of a forgotten entry, never of a purged one', async () => {
    const byId = new Map((await review(ericWeb)).sourceEntries.map((s) => [s.id, s]))
    assert.deepEqual(byId.get(e[0]), { id: e[0], title: 'The hook goes first', state: 'active' })
    assert.deepEqual(byId.get(e[1]), { id: e[1], title: 'An old number', state: 'forgotten' })
    assert.deepEqual(byId.get(e[2]), { id: e[2], title: null, state: 'purged' })
    assert.equal(byId.size, 3)
  })

  it('a contributor sees no title of a forgotten entry', async () => {
    const byId = new Map((await review(anaWeb)).sourceEntries.map((s) => [s.id, s]))
    assert.equal(byId.get(e[0])?.title, 'The hook goes first')
    assert.deepEqual(byId.get(e[1]), { id: e[1], title: null, state: 'forgotten' })
  })

  it('viewing a proposal writes no reads', async () => {
    const n = await reads()
    await review(ericWeb)
    await review(anaWeb)
    assert.equal(await reads(), n)
  })
})
