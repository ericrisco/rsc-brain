// Spec v0.6 «Escritura directa», CA4 and the permission itself (constitution P5 v2.1.0): a curator of a brain,
// in the web, lets one key write to that brain's wiki; nobody else can, not even the curator's own agent with
// the curator's token. The permission is per key and per brain; a curator lists and takes it back.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Writer = { keyId: string; kind: string; name: string; owner: string; grantedBy: string }

describe('the permission to write to the wiki (v0.6)', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let ana: { id: string; key: string }
  let rita: { id: string; key: string }
  let ericWeb: string
  let anaWeb: string
  let ritaWeb: string

  const token = async (session: string, body: Record<string, unknown>) => {
    const r = await w.callWeb(session, 'POST', '/v1/me/tokens', { perm: 'write', days: 30, ...body })
    return r
  }
  const grant = (session: string, slug: string, keyId: string) =>
    w.callWeb(session, 'PUT', `/v1/brains/${slug}/wiki/writers/${keyId}`)
  const writers = async (slug: string) =>
    (await w.callWeb(ericWeb, 'GET', `/v1/brains/${slug}/wiki/writers`)).body.writers as Writer[]

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    ana = await w.person('Ana')
    rita = await w.person('Rita')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'yt', purpose: 'Our channel.' })
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'ops', purpose: 'Operations.' })
    await w.member('yt', ana.id, 'contributor')
    await w.member('yt', rita.id, 'reader')
    ericWeb = await w.web(eric.id)
    anaWeb = await w.web(ana.id)
    ritaWeb = await w.web(rita.id)
  })
  after(async () => w.close())

  it('a curator, in the web, lets a contributor’s token write; the list shows it', async () => {
    const t = await token(anaWeb, { name: 'Ana laptop', brains: ['yt'] })
    assert.equal(t.status, 201, t.text)
    const id = (t.body.token as { id: string }).id
    const r = await grant(ericWeb, 'yt', id)
    assert.equal(r.status, 200, r.text)
    const list = await writers('yt')
    assert.deepEqual(
      list.map((x) => [x.keyId, x.kind, x.name, x.owner, x.grantedBy]),
      [[id, 'token', 'Ana laptop', 'Ana', 'Eric']],
    )
    // Twice is once.
    assert.equal((await grant(ericWeb, 'yt', id)).status, 200)
    assert.equal((await writers('yt')).length, 1)
    const audit = await w.db.one("SELECT target FROM audit WHERE action = 'wiki.writer.grant'")
    assert.equal(audit?.target, id)
  })

  it('CA4: someone who is not a curator of the brain cannot give it', async () => {
    const t = await token(anaWeb, { name: 'Ana desk', brains: ['yt'] })
    const id = (t.body.token as { id: string }).id
    const r = await grant(anaWeb, 'yt', id)
    assert.equal(r.status, 403, r.text)
    // Nor can a reader, nor a stranger to the brain (who is told it does not exist).
    assert.equal((await grant(ritaWeb, 'yt', id)).status, 403)
    assert.equal((await grant(anaWeb, 'ops', id)).status, 404)
    assert.ok(!(await writers('yt')).some((x) => x.keyId === id))
  })

  it('only in the web: the curator’s own token cannot give the permission, to itself or anyone', async () => {
    const t = await token(ericWeb, { name: 'Eric agent', allBrains: true })
    const id = (t.body.token as { id: string }).id
    const secret = (t.body.token as { secret: string }).secret
    const r = await w.call(secret, 'PUT', `/v1/brains/yt/wiki/writers/${id}`)
    assert.equal(r.status, 403, r.text)
    assert.match(r.body.error?.howToProceed ?? '', /web/)
    assert.equal((await grant(ericWeb, 'yt', id)).status, 200)
  })

  it('the key must be able to write in that brain', async () => {
    // A reader's token, a read-only token, a token for another brain, an unknown key.
    const reader = await token(ritaWeb, { name: 'Rita', brains: ['yt'] })
    const readOnly = await token(anaWeb, { name: 'Ana read', perm: 'read', brains: ['yt'] })
    const other = await token(ericWeb, { name: 'Eric ops', brains: ['ops'] })
    for (const t of [reader, readOnly, other]) {
      const r = await grant(ericWeb, 'yt', (t.body.token as { id: string }).id)
      assert.equal(r.status, 400, r.text)
    }
    assert.equal((await grant(ericWeb, 'yt', 'crd_000000000000')).status, 404)
  })

  it('a connected app is one key across the keys it is given when it refreshes', async () => {
    const appKey = await w.app(ana.id, [
      (await w.db.one("SELECT id FROM brains WHERE slug = 'yt'"))?.id as string,
    ])
    const row = await w.db.one<{ grant_id: string }>(
      "SELECT grant_id FROM credentials WHERE kind = 'app' AND account_id = $1",
      [ana.id],
    )
    assert.ok(appKey && row?.grant_id)
    const r = await grant(ericWeb, 'yt', row.grant_id)
    assert.equal(r.status, 200, r.text)
    assert.equal((await writers('yt')).find((x) => x.keyId === row.grant_id)?.kind, 'app')
  })

  it('a curator takes it back, also from an agent’s key; then it is not listed', async () => {
    const id = (await writers('yt')).find((x) => x.name === 'Ana laptop')?.keyId as string
    const r = await w.call(eric.key, 'DELETE', `/v1/brains/yt/wiki/writers/${id}`)
    assert.equal(r.status, 200, r.text)
    assert.ok(!(await writers('yt')).some((x) => x.keyId === id))
    assert.equal((await w.call(eric.key, 'DELETE', `/v1/brains/yt/wiki/writers/${id}`)).status, 404)
    // A contributor cannot take it back.
    const app = (await writers('yt')).find((x) => x.kind === 'app')?.keyId as string
    assert.equal((await w.call(ana.key, 'DELETE', `/v1/brains/yt/wiki/writers/${app}`)).status, 403)
  })

  it('when a token is made: the brains where its person is curator, and only those', async () => {
    const ok = await token(ericWeb, { name: 'Eric writer', brains: ['yt', 'ops'], wikiWrite: ['yt'] })
    assert.equal(ok.status, 201, ok.text)
    const id = (ok.body.token as { id: string }).id
    assert.ok((await writers('yt')).some((x) => x.keyId === id))
    const mine = (await w.callWeb(ericWeb, 'GET', '/v1/me/tokens')).body.tokens as {
      id: string
      wikiWrite: string[]
    }[]
    assert.deepEqual(mine.find((x) => x.id === id)?.wikiWrite, ['yt'])
    const no = await token(anaWeb, { name: 'Ana try', brains: ['yt'], wikiWrite: ['yt'] })
    assert.equal(no.status, 403, no.text)
    const outside = await token(ericWeb, { name: 'Eric x', brains: ['ops'], wikiWrite: ['yt'] })
    assert.equal(outside.status, 400, outside.text)
  })
})
