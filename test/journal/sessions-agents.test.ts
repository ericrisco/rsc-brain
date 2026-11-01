// Review of PR26 (second pass): Activity lists the sessions open now of agents and services, never the
// web's own edits (a person working in the web shows in the feed). The server filters them, so a page
// and its total count only those: a filter in the browser after paging could leave a page empty while
// agents work.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Listed = {
  items: { id: string; client: string | null; day: string | null }[]
  total: number
  next: string | null
}

describe('the open sessions of agents and services', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let agentSession: string

  before(async () => {
    w = await world()
    eric = await w.person('Eric', { isAdmin: true })
    assert.equal((await w.call(eric.key, 'POST', '/v1/brains', { slug: 'ag' })).status, 201)
    // An agent's explicit session, the oldest.
    const s = await w.call(eric.key, 'POST', '/v1/brains/ag/sessions', { purpose: 'Intros' })
    agentSession = (s.body.session as { id: string }).id
    // Three people edit in the web, the newest: three sessions of web edits.
    for (const name of ['Ana', 'Eva', 'Olga']) {
      w.advance(60_000)
      const p = await w.person(name)
      await w.member('ag', p.id, 'contributor')
      const r = await w.callWeb(await w.web(p.id), 'POST', '/v1/brains/ag/corrections', {
        title: `By ${name}`,
        content: `Written by ${name} in the web.`,
      })
      assert.equal(r.status, 201, r.text)
    }
  })
  after(async () => w.close())

  it('agents=1 leaves out the web edits, in the page and in the total', async () => {
    const all = (await w.call(eric.key, 'GET', '/v1/brains/ag/sessions?status=open&limit=2')).body as Listed
    assert.equal(all.total, 4)
    assert.ok(
      all.items.every((x) => x.client === 'web'),
      'the newest page is all web edits',
    )
    const r = await w.call(eric.key, 'GET', '/v1/brains/ag/sessions?status=open&agents=1&limit=2')
    assert.equal(r.status, 200, r.text)
    const page = r.body as Listed
    assert.deepEqual(
      page.items.map((x) => x.id),
      [agentSession],
    )
    assert.equal(page.total, 1)
    assert.equal(page.next, null)
  })

  it('agents is 1 or 0', async () => {
    const r = await w.call(eric.key, 'GET', '/v1/brains/ag/sessions?agents=maybe')
    assert.equal(r.status, 400, r.text)
  })
})
