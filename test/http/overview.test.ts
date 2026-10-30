// Plan B6 §3.5, G5, G7 and G8 (T013): what the home and the overview of a brain show, as v1 operations a
// program can use with the same permissions as the web. "Who am I" says what this key may do (create
// brains, invite people) and the installation; the brains carry their numbers in one aggregate query;
// the overview of a brain gives its numbers, today's sessions, what waits for review, health counts and
// the three first steps, each marked by what happened. A brain the caller cannot read answers like one
// that does not exist.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>
type Stats = {
  pages: number
  entries: number
  uncompiled: number
  conflicts: number
  pendingProposals: number
  lastActivityAt: string | null
}

describe('home and overview (G5, G7, G8)', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let ana: { id: string; key: string }
  let bo: { id: string; key: string }
  let ericWeb: string
  let anaWeb: string

  const save = async (key: string, slug: string, title: string) => {
    const r = await w.call(key, 'POST', `/v1/brains/${slug}/entries`, {
      type: 'learning',
      title,
      content: `${title}: what we saw.`,
    })
    assert.equal(r.status, 201, r.text)
    return (r.body.receipt as { entryId: string }).entryId
  }

  before(async () => {
    w = await world()
    eric = await w.person('Eric', { isAdmin: true })
    ana = await w.person('Ana', { canCreateBrains: false })
    bo = await w.person('Bo')
    ericWeb = await w.web(eric.id)
    anaWeb = await w.web(ana.id)
    for (const slug of ['growth', 'empty']) {
      const r = await w.call(eric.key, 'POST', '/v1/brains', { slug, purpose: `About ${slug}.` })
      assert.equal(r.status, 201, r.text)
    }
    await w.member('growth', ana.id, 'reader')
    assert.equal((await w.call(bo.key, 'POST', '/v1/brains', { slug: 'bos' })).status, 201)
  })
  after(async () => w.close())

  describe('G5: who am I', () => {
    it('says what this key may do and names the installation', async () => {
      const r = await w.call(eric.key, 'GET', '/v1/me')
      assert.equal(r.status, 200, r.text)
      const account = r.body.account as Json
      assert.equal(account.canCreateBrains, true)
      // Inviting happens in the web: a token cannot invite, even an administrator's.
      assert.equal(account.canInvite, false)
      assert.equal(account.totp, false)
      assert.deepEqual(r.body.installation, { name: 'Test', factoryUrl: null })
    })

    it('in the web, the administration may invite; a person without the rights may not', async () => {
      const admin = await w.callWeb(ericWeb, 'GET', '/v1/me')
      assert.equal((admin.body.account as Json).canInvite, true)
      const plain = await w.callWeb(anaWeb, 'GET', '/v1/me')
      assert.deepEqual(
        [(plain.body.account as Json).canCreateBrains, (plain.body.account as Json).canInvite],
        [false, false],
      )
    })

    it('a curator may invite only once the installation allows it, and only while curating a brain', async () => {
      const set = await w.callWeb(ericWeb, 'PUT', '/v1/admin/settings', { curatorsInvite: true })
      assert.equal(set.status, 200, set.text)
      // Allowed, but Ana curates nothing yet.
      assert.equal(((await w.callWeb(anaWeb, 'GET', '/v1/me')).body.account as Json).canInvite, false)
      await w.member('empty', ana.id, 'curator')
      assert.equal(((await w.callWeb(anaWeb, 'GET', '/v1/me')).body.account as Json).canInvite, true)
      await w.callWeb(ericWeb, 'PUT', '/v1/admin/settings', { curatorsInvite: false })
      assert.equal(((await w.callWeb(anaWeb, 'GET', '/v1/me')).body.account as Json).canInvite, false)
      await w.db.query(
        "DELETE FROM memberships WHERE account_id = $1 AND brain_id = (SELECT id FROM brains WHERE slug = 'empty')",
        [ana.id],
      )
    })

    it("a service's main key says what it may do: create brains, never invite through the web", async () => {
      const svc = await w.service('Factory')
      const me = await w.call(svc.key, 'GET', '/v1/me')
      assert.deepEqual(
        [(me.body.account as Json).canCreateBrains, (me.body.account as Json).canInvite],
        [true, false],
      )
    })

    it('the second factor shows once it is on', async () => {
      await w.db.query("UPDATE accounts SET totp_secret = 'sealed' WHERE id = $1", [bo.id])
      assert.equal(((await w.call(bo.key, 'GET', '/v1/me')).body.account as Json).totp, true)
    })
  })

  describe('G7: the numbers of each brain', () => {
    it('a brain starts at zero, with no activity yet', async () => {
      const list = (await w.call(eric.key, 'GET', '/v1/brains')).body.brains as Array<Json & { stats: Stats }>
      const empty = list.find((b) => b.slug === 'empty')
      assert.deepEqual(empty?.stats, {
        pages: 0,
        entries: 0,
        uncompiled: 0,
        conflicts: 0,
        pendingProposals: 0,
        lastActivityAt: null,
      })
      assert.equal(empty?.notifyProposals, false)
    })

    it('counts entries, uncompiled entries, open conflicts and pending proposals', async () => {
      const a = await save(eric.key, 'growth', 'Short intros keep viewers')
      const b = await save(eric.key, 'growth', 'Long intros keep viewers')
      const rel = await w.call(eric.key, 'POST', '/v1/brains/growth/relations', {
        from: a,
        to: b,
        kind: 'contradicts',
      })
      assert.equal(rel.status, 201, rel.text)
      const p = await w.call(eric.key, 'POST', '/v1/brains/growth/proposals', {
        title: 'Intros',
        reason: 'The journal says so.',
        ops: [
          {
            op: 'create',
            address: 'growth/intros',
            type: 'topic',
            title: 'Intros',
            summary: 'How long an intro should be.',
            body: 'Short.',
            sources: [{ entryId: a }],
            reason: 'Two entries.',
          },
        ],
      })
      assert.equal(p.status, 201, p.text)
      const one = await w.call(eric.key, 'GET', '/v1/brains/growth')
      const stats = (one.body.brain as { stats: Stats }).stats
      assert.deepEqual(
        { ...stats, lastActivityAt: typeof stats.lastActivityAt },
        {
          pages: 0,
          entries: 2,
          uncompiled: 2,
          conflicts: 1,
          pendingProposals: 1,
          lastActivityAt: 'string',
        },
      )
      // The same numbers in the list, for every member, readers too.
      const asAna = (await w.call(ana.key, 'GET', '/v1/brains')).body.brains as Array<Json & { stats: Stats }>
      assert.deepEqual(
        asAna.map((x) => [x.slug, x.stats.entries, x.stats.pendingProposals]),
        [['growth', 2, 1]],
      )
    })

    it('says whether I get new proposals by email, per brain', async () => {
      const on = await w.callWeb(ericWeb, 'PUT', '/v1/brains/growth/notify', { notifyProposals: true })
      assert.equal(on.status, 200, on.text)
      const list = (await w.call(eric.key, 'GET', '/v1/brains')).body.brains as Json[]
      assert.deepEqual(
        list.map((b) => [b.slug, b.notifyProposals]),
        [
          ['empty', false],
          ['growth', true],
        ],
      )
      assert.equal(
        ((await w.call(eric.key, 'GET', '/v1/brains/growth')).body.brain as Json).notifyProposals,
        true,
      )
      // Ana's choice is hers.
      assert.equal(
        ((await w.call(ana.key, 'GET', '/v1/brains')).body.brains as Json[])[0]?.notifyProposals,
        false,
      )
    })

    it('lists every brain with one aggregate query, however many there are', async () => {
      const seen: string[] = []
      const query = w.db.query.bind(w.db)
      w.db.query = (async (sql: string, params?: unknown[]) => {
        seen.push(sql)
        return query(sql, params)
      }) as typeof w.db.query
      try {
        await w.call(eric.key, 'GET', '/v1/brains')
      } finally {
        w.db.query = query
      }
      assert.equal(seen.filter((q) => /pending_proposals|count\(\*\)/i.test(q)).length, 1, seen.join('\n'))
    })
  })

  describe('G8: the overview of a brain', () => {
    it('a new brain shows the three first steps, none done; importing waits for its operation', async () => {
      const r = await w.call(eric.key, 'GET', '/v1/brains/empty/overview')
      assert.equal(r.status, 200, r.text)
      assert.deepEqual(r.body.firstSteps, { agentConnected: false, firstEntry: false, imported: false })
      assert.deepEqual(r.body.todaySessions, [])
      assert.deepEqual(r.body.pending, [])
      assert.equal((r.body.stats as Stats).entries, 0)
      assert.deepEqual(r.body.health, {
        orphans: 0,
        broken: 0,
        conflicts: 0,
        stale: 0,
        unavailableSources: 0,
        long: 0,
        similarTitles: 0,
      })
    })

    it('the first entry of an agent marks steps 1 and 2', async () => {
      await save(eric.key, 'empty', 'First thing the agent learnt')
      const r = await w.call(eric.key, 'GET', '/v1/brains/empty/overview')
      assert.deepEqual(r.body.firstSteps, { agentConnected: true, firstEntry: true, imported: false })
    })

    it("today's sessions: client, purpose, reference, status, entries and summary; and what waits", async () => {
      const r = await w.call(eric.key, 'GET', '/v1/brains/growth/overview')
      assert.equal(r.status, 200, r.text)
      const sessions = r.body.todaySessions as Json[]
      assert.equal(sessions.length, 1)
      const s = sessions[0] as Json
      assert.deepEqual(Object.keys(s).sort(), [
        'client',
        'entries',
        'id',
        'lastActivityAt',
        'openedAt',
        'purpose',
        'ref',
        'status',
        'summary',
        'who',
      ])
      assert.deepEqual([s.entries, s.status, s.summary, s.who], [2, 'open', null, 'Eric'])
      const pending = r.body.pending as Json[]
      assert.deepEqual(
        pending.map((p) => [p.title, p.opCount, p.old]),
        [['Intros', 1, false]],
      )
      assert.equal((r.body.stats as Stats).pendingProposals, 1)
      // Health counts are numbers, never the lists themselves.
      for (const v of Object.values(r.body.health as Json)) assert.equal(typeof v, 'number')
    })

    it('a session closed with a summary shows its summary', async () => {
      const opened = await w.call(eric.key, 'POST', '/v1/brains/growth/sessions', {
        purpose: 'Review intros',
        ref: 'run-7',
      })
      const id = (opened.body.session as { id: string }).id
      const sum = await w.call(eric.key, 'POST', `/v1/sessions/${id}/summary`, {
        title: 'Intros reviewed',
        content: 'Short intros win; we keep them under 10 seconds.',
      })
      assert.ok(sum.status < 300, sum.text)
      const r = await w.call(eric.key, 'GET', '/v1/brains/growth/overview')
      const s = (r.body.todaySessions as Json[]).find((x) => x.id === id)
      assert.equal(s?.ref, 'run-7')
      assert.equal(s?.purpose, 'Review intros')
      assert.match(String(s?.summary), /Short intros win/)
    })

    it('a web session writing does not count as an agent connected', async () => {
      assert.equal((await w.call(eric.key, 'POST', '/v1/brains', { slug: 'by-hand' })).status, 201)
      const wrote = await w.callWeb(ericWeb, 'POST', '/v1/brains/by-hand/entries', {
        type: 'note',
        title: 'Typed in the web',
        content: 'A person wrote this.',
      })
      if (wrote.status === 201) {
        const r = await w.call(eric.key, 'GET', '/v1/brains/by-hand/overview')
        assert.deepEqual(r.body.firstSteps, { agentConnected: false, firstEntry: true, imported: false })
      } else assert.equal(wrote.status, 403, wrote.text)
    })

    it('no access answers exactly like no brain: a stranger, an administrator without membership, a narrowed token', async () => {
      const nowhere = await w.call(eric.key, 'GET', '/v1/brains/nowhere/overview')
      assert.equal(nowhere.status, 404)
      const stranger = await w.call(ana.key, 'GET', '/v1/brains/empty/overview')
      const admin = await w.call(eric.key, 'GET', '/v1/brains/bos/overview')
      const growthId = String((await w.db.one("SELECT id FROM brains WHERE slug = 'growth'"))?.id)
      const narrow = await w.token(eric.id, { brainIds: [growthId] })
      const scoped = await w.call(narrow, 'GET', '/v1/brains/empty/overview')
      for (const r of [stranger, admin, scoped]) {
        assert.equal(r.status, 404, r.text)
        assert.deepEqual(r.body, nowhere.body)
      }
      // The list and the detail follow the same rule.
      assert.deepEqual(
        ((await w.call(narrow, 'GET', '/v1/brains')).body.brains as Json[]).map((b) => b.slug),
        ['growth'],
      )
      assert.deepEqual((await w.call(eric.key, 'GET', '/v1/brains/bos')).body, nowhere.body)
    })

    it('a reader sees the overview, read-only: the same numbers', async () => {
      const r = await w.call(ana.key, 'GET', '/v1/brains/growth/overview')
      assert.equal(r.status, 200, r.text)
      const mine = await w.call(eric.key, 'GET', '/v1/brains/growth/overview')
      assert.deepEqual(r.body.stats, mine.body.stats)
      assert.equal((r.body.stats as Stats).entries, 3, 'two entries and the summary of a session')
    })

    it('only the sessions of today, in the time zone of the installation', async () => {
      w.advance(2 * 24 * 3_600_000)
      const r = await w.call(eric.key, 'GET', '/v1/brains/growth/overview')
      assert.deepEqual(r.body.todaySessions, [])
      w.advance(-2 * 24 * 3_600_000)
    })
  })
})
