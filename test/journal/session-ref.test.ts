// Review of PR26 (second pass): the session an entry is in carries its client and its author, so the web
// names a session the same everywhere («Web edits · Eric», «Unnamed work · Codex»), on an entry's page and
// beside an entry in a list too.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>

describe('the session reference of an entry', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let ericWeb: string

  before(async () => {
    w = await world()
    eric = await w.person('Eric', { isAdmin: true })
    ericWeb = await w.web(eric.id)
    assert.equal((await w.call(eric.key, 'POST', '/v1/brains', { slug: 'refs' })).status, 201)
  })
  after(async () => w.close())

  it('an entry written in the web: its session says the web and who', async () => {
    const r = await w.callWeb(ericWeb, 'POST', '/v1/brains/refs/corrections', {
      title: 'Short intros',
      content: 'Keep intros short.',
    })
    assert.equal(r.status, 201, r.text)
    const id = (r.body.receipt as { entryId: string }).entryId
    const e = await w.callWeb(ericWeb, 'GET', `/v1/entries/${id}`)
    assert.equal(e.status, 200, e.text)
    const s = e.body.session as Json
    assert.equal(s.client, 'web')
    assert.deepEqual(s.author, { id: eric.id, name: 'Eric' })
    assert.ok(s.day, 'the session of a day')
  })

  it('an entry written by a key: its session says the key’s client and who', async () => {
    const r = await w.call(eric.key, 'POST', '/v1/brains/refs/entries', {
      type: 'learning',
      title: 'By a key',
      content: 'Written by a key.',
    })
    assert.equal(r.status, 201, r.text)
    const id = (r.body.receipt as { entryId: string }).entryId
    const s = (await w.call(eric.key, 'GET', `/v1/entries/${id}`)).body.session as Json
    assert.ok('client' in s)
    assert.notEqual(s.client, 'web')
    assert.deepEqual(s.author, { id: eric.id, name: 'Eric' })
  })
})
