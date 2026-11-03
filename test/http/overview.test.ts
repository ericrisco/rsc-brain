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
      assert.equal(account.totp, null)
      // A key does not learn who administers the installation (review of PR26): only a person's web session
      // does, to know whom to ask.
      assert.deepEqual(r.body.installation, { name: 'Test', factoryUrl: null })
      const web = await w.callWeb(ericWeb, 'GET', '/v1/me')
      assert.deepEqual((web.body.installation as Json).admins, ['Eric'])
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

    it('the second factor shows once it is on, and only to the web: other keys learn nothing of how the person signs in', async () => {
      await w.db.query("UPDATE accounts SET totp_secret = 'sealed' WHERE id = $1", [bo.id])
      const web = await w.callWeb(await w.web(bo.id), 'GET', '/v1/me')
      assert.equal((web.body.account as Json).totp, true)
      const bos = String((await w.db.one("SELECT id FROM brains WHERE slug = 'bos'"))?.id)
      for (const key of [bo.key, await w.app(bo.id, [bos])]) {
        const r = await w.call(key, 'GET', '/v1/me')
        assert.equal(r.status, 200, r.text)
        assert.equal((r.body.account as Json).totp, null, r.text)
      }
      await w.db.query('UPDATE accounts SET totp_secret = NULL WHERE id = $1', [bo.id])
      assert.equal(((await w.call(bo.key, 'GET', '/v1/me')).body.account as Json).totp, null)
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

  // Each number counts exactly what it says, and nothing next to it (review of PR18: the numbers must
  // not be loose). Facts that only other specs make happen (a compiled entry, a decided proposal, a
  // retired page, a conflict waiting for a person) are set in the database directly.
  describe('G7: what each number leaves out', () => {
    const brainOf = async (slug: string) =>
      String((await w.db.one('SELECT id FROM brains WHERE slug = $1', [slug]))?.id)
    const stats = async (slug: string) =>
      ((await w.call(eric.key, 'GET', `/v1/brains/${slug}`)).body.brain as { stats: Stats }).stats
    const relate = async (from: string, to: string, kind: string) => {
      const r = await w.call(eric.key, 'POST', '/v1/brains/counts/relations', { from, to, kind })
      assert.equal(r.status, 201, r.text)
    }
    const propose = async (title: string) => {
      const source = await save(eric.key, 'counts', `Source of ${title}`)
      const r = await w.call(eric.key, 'POST', '/v1/brains/counts/proposals', {
        title,
        reason: 'Because.',
        ops: [
          {
            op: 'create',
            address: `counts/${title.toLowerCase().replaceAll(' ', '-')}`,
            type: 'topic',
            title,
            summary: 'A page.',
            body: 'Body.',
            sources: [{ entryId: source }],
            reason: 'Asked.',
          },
        ],
      })
      assert.equal(r.status, 201, r.text)
      return String((r.body.proposal as { id: string }).id)
    }

    before(async () => {
      assert.equal((await w.call(eric.key, 'POST', '/v1/brains', { slug: 'counts' })).status, 201)
    })

    it('entries: only active ones; uncompiled: active, not compiled, never a session summary', async () => {
      const a = await save(eric.key, 'counts', 'Compiled already')
      await save(eric.key, 'counts', 'Still loose')
      const c = await save(eric.key, 'counts', 'Forgotten later')
      await w.db.query('UPDATE entries SET compiled = true WHERE id = $1', [a])
      await w.db.query("UPDATE entries SET state = 'forgotten' WHERE id = $1", [c])
      const opened = await w.call(eric.key, 'POST', '/v1/brains/counts/sessions', { purpose: 'Count' })
      const sid = (opened.body.session as { id: string }).id
      const sum = await w.call(eric.key, 'POST', `/v1/sessions/${sid}/summary`, {
        title: 'Counted',
        content: 'We counted.',
      })
      assert.ok(sum.status < 300, sum.text)
      const st = await stats('counts')
      // a, b and the summary are active; c is forgotten. Only b is loose: a is compiled, the summary
      // never goes to the wiki.
      assert.deepEqual([st.entries, st.uncompiled], [3, 1])
    })

    it('pages: every page but the retired ones', async () => {
      const id = await brainOf('counts')
      for (const [n, status] of [
        [1, 'current'],
        [2, 'stale'],
        [3, 'retired'],
      ] as const) {
        await w.db.query(
          `INSERT INTO pages (id, brain_id, address, type, title, status, created_at, updated_at)
           VALUES ($1, $2, $3, 'topic', $4, $5, $6, $6)`,
          [`pg_count${n}`, id, `counts/p${n}`, `Page ${n}`, status, w.clock()],
        )
      }
      assert.equal((await stats('counts')).pages, 2)
    })

    it('conflicts: open contradictions and the ones waiting for a person; never settled ones or forgotten entries', async () => {
      const e = async (t: string) => save(eric.key, 'counts', t)
      // Open.
      await relate(await e('Open one'), await e('Open two'), 'contradicts')
      // Settled by a later supersedes, and by a not_related, on the same pair (either direction).
      const s1 = await e('Settled one')
      const s2 = await e('Settled two')
      await relate(s1, s2, 'contradicts')
      w.advance(1000)
      await relate(s2, s1, 'supersedes')
      const n1 = await e('Unrelated one')
      const n2 = await e('Unrelated two')
      await relate(n1, n2, 'contradicts')
      w.advance(1000)
      await relate(n1, n2, 'not_related')
      // A supersedes older than the contradiction does not settle it.
      const o1 = await e('Older one')
      const o2 = await e('Older two')
      await relate(o2, o1, 'supersedes')
      w.advance(1000)
      await relate(o1, o2, 'contradicts')
      // One side forgotten.
      const f1 = await e('Forgotten one')
      const f2 = await e('Forgotten two')
      await relate(f1, f2, 'contradicts')
      const g1 = await e('Forgotten three')
      const g2 = await e('Forgotten four')
      await relate(g1, g2, 'contradicts')
      await w.db.query("UPDATE entries SET state = 'forgotten' WHERE id = ANY($1)", [[f2, g1]])
      // Waiting for a person; and one a person rejected.
      const p1 = await e('Person one')
      const p2 = await e('Person two')
      const r1 = await e('Rejected one')
      const r2 = await e('Rejected two')
      await relate(p1, p2, 'supersedes')
      await relate(r1, r2, 'contradicts')
      await w.db.query(
        "UPDATE relations SET status = 'pending_person' WHERE from_id = $1 AND to_id = $2 AND kind = 'supersedes'",
        [p1, p2],
      )
      await w.db.query("UPDATE relations SET status = 'rejected' WHERE from_id = $1 AND to_id = $2", [r1, r2])
      // Open, older-supersedes and waiting-for-a-person.
      assert.equal((await stats('counts')).conflicts, 3)
    })

    it('proposals: the numbers and the overview list only the pending ones', async () => {
      const keep = await propose('Kept waiting')
      const done = await propose('Decided already')
      await w.db.query("UPDATE proposals SET status = 'approved' WHERE id = $1", [done])
      assert.equal((await stats('counts')).pendingProposals, 1)
      const ov = await w.call(eric.key, 'GET', '/v1/brains/counts/overview')
      assert.equal(ov.status, 200, ov.text)
      assert.deepEqual(
        (ov.body.pending as Json[]).map((p) => p.id),
        [keep],
      )
      assert.equal((ov.body.stats as Stats).pendingProposals, 1)
    })
  })

  // Step 1 «Connect your agent» marks itself on the first thing a key that is not a web session does in
  // the brain: opening a session, saving, proposing, or only reading (a search, a read, asking for
  // context). A person in the web doing the same does not count.
  describe('G8: what marks «Connect your agent»', () => {
    const steps = async (slug: string) =>
      (await w.call(eric.key, 'GET', `/v1/brains/${slug}/overview`)).body.firstSteps as Json
    const fresh = async (slug: string) => {
      assert.equal((await w.call(eric.key, 'POST', '/v1/brains', { slug })).status, 201)
      return String((await w.db.one('SELECT id FROM brains WHERE slug = $1', [slug]))?.id)
    }
    const webCredential = async (session: string) =>
      String(
        (
          await w.db.one("SELECT id FROM credentials WHERE secret_hash = $1 AND kind = 'web'", [
            (await import('../../src/auth/secrets.ts')).hashSecret(session),
          ])
        )?.id,
      )

    it('a proposal from an agent marks it; the same proposal from the web does not', async () => {
      const web = await webCredential(ericWeb)
      // Only the proposal comes from a key that is not the web: the entry it cites, its session and
      // what was read are made to look like the web's.
      const asWeb = async (brainId: string) => {
        await w.db.query('UPDATE sessions SET credential_id = $2 WHERE brain_id = $1', [brainId, web])
        await w.db.query('DELETE FROM trail WHERE brain_id = $1', [brainId])
      }
      const proposeIn = async (slug: string) => {
        const source = await save(eric.key, slug, 'Why')
        const r = await w.call(eric.key, 'POST', `/v1/brains/${slug}/proposals`, {
          title: 'A page',
          reason: 'R.',
          ops: [
            {
              op: 'create',
              address: `${slug}/a`,
              type: 'topic',
              title: 'A',
              summary: 'A.',
              body: 'A.',
              sources: [{ entryId: source }],
              reason: 'A.',
            },
          ],
        })
        assert.equal(r.status, 201, r.text)
      }
      const agent = await fresh('by-agent')
      await proposeIn('by-agent')
      await asWeb(agent)
      assert.equal((await steps('by-agent')).agentConnected, true)
      const person = await fresh('by-web')
      await proposeIn('by-web')
      await asWeb(person)
      await w.db.query('UPDATE proposals SET credential_id = $2 WHERE brain_id = $1', [person, web])
      assert.equal((await steps('by-web')).agentConnected, false)
    })

    it('an agent that only reads marks it: a search, or asking for context', async () => {
      await fresh('read-only')
      assert.equal((await steps('read-only')).agentConnected, false)
      const asked = await w.call(eric.key, 'GET', '/v1/brains/read-only/context')
      assert.equal(asked.status, 200, asked.text)
      assert.equal((await steps('read-only')).agentConnected, true)
      await fresh('searched')
      const found = await w.call(eric.key, 'GET', '/v1/search?q=anything&brains=searched')
      assert.equal(found.status, 200, found.text)
      assert.equal(
        await w.db.one(
          "SELECT 1 FROM sessions WHERE brain_id = (SELECT id FROM brains WHERE slug = 'searched')",
        ),
        undefined,
        'a search opens no session: the trail is what marks it',
      )
      assert.equal((await steps('searched')).agentConnected, true)
    })

    // Pack rule 7: someone who is not a curator never learns about other people's searches and reads.
    it("only reads the viewer may see mark it: a reader does not learn of another member's search", async () => {
      await fresh('peers')
      await w.member('peers', ana.id, 'reader')
      await w.member('peers', bo.id, 'contributor')
      const seenBy = async (web: string) =>
        ((await w.callWeb(web, 'GET', '/v1/brains/peers/overview')).body.firstSteps as Json).agentConnected
      const found = await w.call(bo.key, 'GET', '/v1/search?q=anything&brains=peers')
      assert.equal(found.status, 200, found.text)
      assert.equal(await seenBy(anaWeb), false, "a reader does not see Bo's agent searching")
      assert.equal(await seenBy(ericWeb), true, 'a curator sees every read')
      const read = await w.call(ana.key, 'GET', '/v1/brains/peers/context')
      assert.equal(read.status, 200, read.text)
      assert.equal(await seenBy(anaWeb), true, "the reader's own agent marks it for her")
    })

    it('a person reading in the web does not mark it', async () => {
      await fresh('web-reads')
      const asked = await w.callWeb(ericWeb, 'GET', '/v1/brains/web-reads/context')
      assert.equal(asked.status, 200, asked.text)
      assert.equal((await steps('web-reads')).agentConnected, false)
    })
  })

  describe('G8: the overview of a brain', () => {
    it('a new brain shows the three first steps, none done; importing waits for its operation', async () => {
      const r = await w.call(eric.key, 'GET', '/v1/brains/empty/overview')
      assert.equal(r.status, 200, r.text)
      assert.deepEqual(r.body.firstSteps, {
        agentConnected: false,
        firstEntry: false,
        imported: false,
        importable: true,
      })
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

    it('a brain holding only a withdrawn proposal is no longer importable (review of PR32)', async () => {
      assert.equal((await w.call(eric.key, 'POST', '/v1/brains', { slug: 'withdrawn' })).status, 201)
      const ov = async () =>
        ((await w.call(eric.key, 'GET', '/v1/brains/withdrawn/overview')).body.firstSteps as Json).importable
      assert.equal(await ov(), true)
      await w.db.query(
        `INSERT INTO proposals (id, brain_id, title, author_id, credential_id, status, created_at)
         SELECT 'prp_withdrawn', id, 'Gone', $1, 'crd_x', 'withdrawn', now() FROM brains WHERE slug = 'withdrawn'`,
        [eric.id],
      )
      assert.equal(await ov(), false)
    })

    it('the first entry of an agent marks steps 1 and 2', async () => {
      await save(eric.key, 'empty', 'First thing the agent learnt')
      const r = await w.call(eric.key, 'GET', '/v1/brains/empty/overview')
      // Something is in it now: it can no longer be imported into (review of PR32: any proposal counts too).
      assert.deepEqual(r.body.firstSteps, {
        agentConnected: true,
        firstEntry: true,
        imported: false,
        importable: false,
      })
    })

    it("today's sessions: client, purpose, reference, status, entries and summary; and what waits", async () => {
      const r = await w.call(eric.key, 'GET', '/v1/brains/growth/overview')
      assert.equal(r.status, 200, r.text)
      const sessions = r.body.todaySessions as Json[]
      assert.equal(sessions.length, 1)
      const s = sessions[0] as Json
      assert.deepEqual(Object.keys(s).sort(), [
        'client',
        'day',
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
      // Saved without opening a session: the session of the day has no purpose, not a placeholder word.
      assert.equal(s.purpose, '')
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
        assert.deepEqual(r.body.firstSteps, {
          agentConnected: false,
          firstEntry: true,
          imported: false,
          importable: false,
        })
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
