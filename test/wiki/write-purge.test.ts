// Spec v0.6 «Escritura directa» with constitution P5 («nada se borra sin rastro, salvo la purga»): the receipt of a
// direct write, kept so a retry with the same request key gets it again, holds no page text — its warnings and
// neighbours are worked out again from the wiki as it is. So text purged after the write is in no receipt, and a
// retry does not bring it back (review of feat/v06, finding 1).
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

const SECRET = 'Paco Pérez, DNI 12345678Z'

describe('a direct write’s receipt keeps no page text (v0.6)', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let ericWeb: string
  let adminWeb: string
  let writer: string
  let source: string

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    const admin = await w.person('Admin', { isAdmin: true })
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'yt', purpose: 'Our channel.' })
    ericWeb = await w.web(eric.id)
    adminWeb = await w.web(admin.id)
    const t = await w.callWeb(ericWeb, 'POST', '/v1/me/tokens', {
      name: 'Eric agent',
      perm: 'write',
      brains: ['yt'],
      days: 30,
      wikiWrite: ['yt'],
    })
    writer = (t.body.token as { secret: string }).secret
    const e = await w.call(eric.key, 'POST', '/v1/brains/yt/entries', {
      type: 'fact',
      title: 'F',
      content: 'A fact.',
    })
    source = (e.body.receipt as { entryId: string }).entryId
    const made = await w.callWeb(ericWeb, 'POST', '/v1/brains/yt/wiki/changes', {
      op: 'create',
      address: 'contacts',
      type: 'topic',
      title: 'Contacts',
      summary: 'Who to call.',
      body: 'Ask the team.',
    })
    assert.equal(made.status, 201, made.text)
    // Revision 2 copies a personal datum into the summary, the part neighbours show.
    const r = await w.callWeb(ericWeb, 'PATCH', '/v1/brains/yt/pages/contacts', {
      baseRevision: 1,
      summary: `Call ${SECRET}.`,
    })
    assert.equal(r.status < 300, true, r.text)
  })
  after(async () => w.close())

  it('purged after the write: neither the stored receipt nor a retry carries it', async () => {
    const body = {
      title: 'Near the contacts',
      requestKey: 'req-near-1',
      ops: [
        {
          op: 'create',
          address: 'near',
          type: 'topic',
          title: 'Near',
          summary: '',
          body: 'Next to them.',
          sources: [{ entryId: source }],
          links: [{ kind: 'related', to: 'contacts' }],
          reason: 'x',
        },
      ],
    }
    const first = await w.call(writer, 'POST', '/v1/brains/yt/wiki/write', body)
    assert.equal(first.status, 201, first.text)
    // Said in the answer, as the wiki stood then.
    assert.match(first.text, /12345678Z/)
    const stored = await w.db.query<{ r: string }>('SELECT receipt::text AS r FROM request_keys')
    assert.ok(stored.length > 0)
    assert.ok(
      stored.every((x) => !x.r.includes('12345678Z')),
      'no page text in the stored receipt',
    )
    const purge = await w.callWeb(adminWeb, 'POST', '/v1/brains/yt/wiki/purge', {
      address: 'contacts',
      revision: 2,
      text: [SECRET],
      reason: 'personal data',
    })
    assert.equal(purge.status, 200, purge.text)
    const again = await w.call(writer, 'POST', '/v1/brains/yt/wiki/write', body)
    assert.equal(again.status, 201, again.text)
    assert.doesNotMatch(again.text, /12345678Z|Paco/)
    assert.deepEqual(
      [again.body.applied, again.body.logId, again.body.revised],
      [first.body.applied, first.body.logId, first.body.revised],
    )
    // Rebuilt from the wiki as it is: the neighbour, with what it says now.
    const n = again.body.neighbours as { address: string; summary: string }[]
    assert.equal(n.find((x) => x.address === 'contacts')?.summary, 'Who to call.')
  })
})
