// Spec B6 «Profile» (PR24 review): what acts in a person's name. The list of tokens carries the expired ones,
// marked, and never a revoked one; a connected app says when its key first reached rsc-brain (the live check
// of «Connect your agent» waits for that, not for the code exchange); and «Revoke all tokens and apps» ends
// every token and connection of the person at once, leaving web sessions and other people alone.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>

describe('the keys of a person, from the profile', { skip: skipPg }, () => {
  let w: World
  before(async () => {
    w = await world()
    await w.call((await w.person('Owner')).key, 'POST', '/v1/brains', { slug: 'keys', purpose: 'Keys.' })
  })
  after(async () => w.close())

  const brainId = async () => String((await w.db.one('SELECT id FROM brains WHERE slug = $1', ['keys']))?.id)
  const make = async (session: string, name: string, days = 30) => {
    const r = await w.callWeb(session, 'POST', '/v1/me/tokens', { name, perm: 'read', allBrains: true, days })
    assert.equal(r.status, 201, r.text)
    return r.body.token as { id: string; secret: string }
  }
  const listed = async (session: string) =>
    ((await w.callWeb(session, 'GET', '/v1/me/tokens')).body.tokens as Json[]) ?? []

  it('lists expired tokens, marked, and never a revoked one', async () => {
    const p = await w.person('Exa')
    const web = await w.web(p.id)
    const old = await make(web, 'Old one', 30)
    w.advance(31 * 86_400_000)
    // A web session ends after 14 days unused: a new one, a month later.
    const web2 = await w.web(p.id)
    const gone = await make(web2, 'Revoked one')
    await w.callWeb(web2, 'DELETE', `/v1/me/tokens/${gone.id}`)
    const live = await make(web2, 'Live one')
    const tokens = await listed(web2)
    const byName = Object.fromEntries(tokens.map((t) => [t.name, t]))
    assert.equal(byName['Old one']?.expired, true, 'the expired one is there, marked')
    assert.equal(byName['Live one']?.expired, false)
    assert.equal(byName['Revoked one'], undefined, 'a revoked one is never listed')
    assert.equal(byName['Old one']?.id, old.id)
    assert.equal(byName['Live one']?.id, live.id)
    // The account's own original token (made by the test world) counts too; none of them carries a secret.
    assert.ok(!JSON.stringify(tokens).includes(live.secret))
  })

  it('a connected app says when its key first made a request, not when it was made', async () => {
    const p = await w.person('Apu')
    const key = await w.app(p.id, [await brainId()])
    const web = await w.web(p.id)
    const before = ((await w.callWeb(web, 'GET', '/v1/me/apps')).body.apps as Json[])[0]
    assert.equal(before?.lastRequestAt, null, 'made, not used yet')
    await w.call(key, 'GET', '/v1/me')
    const after = ((await w.callWeb(web, 'GET', '/v1/me/apps')).body.apps as Json[])[0]
    assert.equal(typeof after?.lastRequestAt, 'string')
  })

  it('«Revoke all tokens and apps» ends every token and connection of the person, and nothing else', async () => {
    const p = await w.person('Rax')
    const other = await w.person('Ote')
    const web = await w.web(p.id)
    const t1 = await make(web, 'One')
    await make(web, 'Two')
    const app = await w.app(p.id, [await brainId()])
    const theirs = await w.app(other.id, [await brainId()])
    const r = await w.callWeb(web, 'POST', '/v1/me/revoke-all', {})
    // Three tokens: the two made here and the one the test world gave the person.
    assert.deepEqual([r.status, r.body], [200, { tokens: 3, apps: 1 }], r.text)
    assert.equal((await w.call(t1.secret, 'GET', '/v1/me')).status, 401)
    assert.equal((await w.call(p.key, 'GET', '/v1/me')).status, 401)
    assert.equal((await w.call(app, 'GET', '/v1/me')).status, 401)
    assert.equal((await w.callWeb(web, 'GET', '/v1/me')).status, 200, 'the web session stays')
    assert.equal((await w.call(other.key, 'GET', '/v1/me')).status, 200, "someone else's token stays")
    assert.equal((await w.call(theirs, 'GET', '/v1/me')).status, 200, "someone else's app stays")
    assert.deepEqual(await listed(web), [])
    const audited = await w.db.one(
      "SELECT detail FROM audit WHERE action = 'keys.revoke_all' AND actor_id = $1",
      [p.id],
    )
    assert.match(String(audited?.detail), /3 token\(s\), 1 app\(s\)/)
    // Only in the web.
    const byToken = await w.call(other.key, 'POST', '/v1/me/revoke-all', {})
    assert.deepEqual([byToken.status, byToken.body.error?.code], [403, 'web_only'])
  })
})
