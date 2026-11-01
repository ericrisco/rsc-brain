// What the home and the overview of a brain show (spec B6 «Home», «Overview»; plan §3.5 G5, G7, G8):
// "who am I" with what this key may do, the numbers of each brain in one aggregate query, and the
// overview of one brain — its numbers, today's sessions, what waits for review, health counts and the
// three first steps, each marked by what happened in the brain. Every brain goes through inBrain or the
// key's own list, so one the caller cannot read answers like one that does not exist (constitution P4).
import { can } from '../auth/can.ts'
import { actorOf } from '../auth/principal.ts'
import type { Db } from '../db/db.ts'
import { type BrainListed, getBrain, listBrains } from './brains.ts'
import { type Ctx, inBrain } from './context.ts'
import { lastSeq } from './events.ts'
import { installation } from './installation.ts'
import { OPEN_CONFLICT } from './relations.ts'
import { dayText } from './sessions.ts'
import { wikiHealth } from './wiki/health.ts'
import { proposalOf } from './wiki/proposals.ts'

export type BrainStats = {
  pages: number
  entries: number
  uncompiled: number
  conflicts: number
  pendingProposals: number
  lastActivityAt: string | null
}
export type BrainWithStats = BrainListed & { stats: BrainStats; notifyProposals: boolean }

// The numbers of several brains, and the caller's own choice of mail, in one query.
async function statsOf(
  db: Db,
  brainIds: string[],
  accountId: string,
): Promise<Map<string, { stats: BrainStats; notifyProposals: boolean }>> {
  const out = new Map<string, { stats: BrainStats; notifyProposals: boolean }>()
  if (brainIds.length === 0) return out
  const rows = await db.query(
    `SELECT b.id,
            (SELECT count(*)::int FROM pages p WHERE p.brain_id = b.id AND p.status <> 'retired') AS pages,
            (SELECT count(*)::int FROM entries e WHERE e.brain_id = b.id AND e.state = 'active') AS entries,
            (SELECT count(*)::int FROM entries e WHERE e.brain_id = b.id AND e.state = 'active'
                AND NOT e.compiled AND e.type <> 'summary') AS uncompiled,
            (SELECT count(*)::int FROM relations r WHERE r.brain_id = b.id AND ${OPEN_CONFLICT}) AS conflicts,
            (SELECT count(*)::int FROM proposals p WHERE p.brain_id = b.id AND p.status = 'pending')
              AS pending_proposals,
            greatest((SELECT max(s.last_activity_at) FROM sessions s WHERE s.brain_id = b.id),
                     (SELECT max(p.created_at) FROM proposals p WHERE p.brain_id = b.id),
                     (SELECT max(l.at) FROM wiki_log l WHERE l.brain_id = b.id)) AS last_activity_at,
            coalesce(m.notify_proposals, false) AS notify_proposals
       FROM brains b LEFT JOIN memberships m ON m.brain_id = b.id AND m.account_id = $2
      WHERE b.id = ANY($1)`,
    [brainIds, accountId],
  )
  for (const r of rows) {
    out.set(String(r.id), {
      stats: {
        pages: Number(r.pages),
        entries: Number(r.entries),
        uncompiled: Number(r.uncompiled),
        conflicts: Number(r.conflicts),
        pendingProposals: Number(r.pending_proposals),
        lastActivityAt: r.last_activity_at == null ? null : (r.last_activity_at as Date).toISOString(),
      },
      notifyProposals: Boolean(r.notify_proposals),
    })
  }
  return out
}

const ZERO: BrainStats = {
  pages: 0,
  entries: 0,
  uncompiled: 0,
  conflicts: 0,
  pendingProposals: 0,
  lastActivityAt: null,
}

async function withStats(ctx: Ctx, brains: BrainListed[]): Promise<BrainWithStats[]> {
  const s = await statsOf(
    ctx.db,
    brains.map((b) => b.id),
    ctx.who.accountId,
  )
  return brains.map((b) => ({
    ...b,
    stats: s.get(b.id)?.stats ?? ZERO,
    notifyProposals: s.get(b.id)?.notifyProposals ?? false,
  }))
}

export async function listBrainsWithStats(ctx: Ctx): Promise<BrainWithStats[]> {
  return withStats(ctx, await listBrains(ctx))
}

export async function getBrainWithStats(ctx: Ctx, slug: string): Promise<BrainWithStats> {
  return (await withStats(ctx, [await getBrain(ctx, slug)]))[0] as BrainWithStats
}

// G5: who this key is, what it may do, and the installation.
export async function whoAmI(ctx: Ctx) {
  const w = ctx.who
  const inst = await installation(ctx.db)
  const facts = await ctx.db.one<{ totp: boolean; curates: boolean }>(
    `SELECT a.totp_secret IS NOT NULL AS totp,
            EXISTS (SELECT 1 FROM memberships m WHERE m.account_id = a.id AND m.role = 'curator') AS curates
       FROM accounts a WHERE a.id = $1`,
    [w.accountId],
  )
  // Only a person's web session learns who administers the installation (whom to ask); a key never does.
  const admins =
    w.credential.kind === 'web'
      ? await ctx.db.query(
          `SELECT name FROM accounts WHERE is_admin AND kind = 'person' AND status = 'active' ORDER BY created_at, id LIMIT 5`,
        )
      : null
  // Inviting is a person's act in the web (domain/invitations.ts): the administration always; a curator
  // when the installation allows it.
  const person = w.kind === 'person' && w.credential.kind === 'web'
  const canInvite = person && (w.isAdmin || (inst.curatorsInvite && Boolean(facts?.curates)))
  return {
    account: {
      id: w.accountId,
      kind: w.kind,
      name: w.name,
      email: w.email,
      isAdmin: w.isAdmin,
      canCreateBrains: can(actorOf(w), 'brain.create').ok,
      canInvite,
      // How the person signs in is the person's business: only their web session learns it.
      totp: w.credential.kind === 'web' ? Boolean(facts?.totp) : null,
    },
    key: {
      id: w.credential.id,
      kind: w.credential.kind,
      perm: w.credential.perm,
      ref: w.credential.ref,
      agent: w.credential.agent,
    },
    // The address of RSC Factory the administration set (plan G4): a run's reference opens there (CA9).
    // Who to ask about the installation (the web names them where only the administration may go).
    installation: {
      name: inst.name,
      factoryUrl: inst.factoryUrl,
      ...(admins ? { admins: admins.map((r) => String(r.name)) } : {}),
    },
  }
}

export const TODAY_SESSIONS = 20
export const PENDING_SHOWN = 5
const SUMMARY_CHARS = 300

// G8: the overview of one brain.
export async function brainOverview(ctx: Ctx, slug: string) {
  const { brain, role } = await inBrain(ctx, { slug })
  const db = ctx.db
  const tz = ctx.tz ?? 'UTC'
  const now = ctx.clock()
  // Read first: every event numbered up to here was committed before the queries below, so they show
  // it. A stream that resumes from this id (Last-Event-ID) misses nothing that came after.
  const cursor = String(await lastSeq(db))
  const stats = (await statsOf(db, [brain.id], ctx.who.accountId)).get(brain.id)?.stats ?? ZERO
  const sessions = await db.query(
    `SELECT s.id, s.purpose, s.day, s.ref, s.status, s.opened_at, s.last_activity_at, a.name AS who,
            s.client, se.content AS summary,
            (SELECT count(*)::int FROM entries e WHERE e.session_id = s.id AND e.state = 'active'
                AND e.type <> 'summary') AS entries
       FROM sessions s JOIN accounts a ON a.id = s.account_id
       LEFT JOIN entries se ON se.id = s.summary_entry_id AND se.state = 'active'
      WHERE s.brain_id = $1
        AND s.last_activity_at >= (date_trunc('day', $2::timestamptz AT TIME ZONE $3) AT TIME ZONE $3)
        AND s.last_activity_at <= $2
      ORDER BY s.last_activity_at DESC, s.id LIMIT $4`,
    [brain.id, now, tz, TODAY_SESSIONS],
  )
  const pending = await db.query(
    `SELECT p.*, (SELECT count(*)::int FROM proposal_ops o WHERE o.proposal_id = p.id) AS op_count
       FROM proposals p WHERE p.brain_id = $1 AND p.status = 'pending'
      ORDER BY p.created_at DESC, p.id DESC LIMIT $2`,
    [brain.id, PENDING_SHOWN],
  )
  // Pack rule 7: someone who is not a curator never learns about other people's searches and reads, so
  // only the trail rows they may see count (the same rows the trail answers them: their own keys).
  // Sessions and proposals count for everyone; the overview already shows them.
  const mine =
    role === 'curator'
      ? null
      : ctx.who.credential.kind === 'short'
        ? { sql: 't.credential_id = $2', id: ctx.who.credential.id }
        : { sql: 't.account_id = $2', id: ctx.who.accountId }
  const steps = await db.one<{ agent: boolean; entry: boolean }>(
    // An agent connected: a key that is not a web session did something in this brain — opened a
    // session, saved, proposed, or only read (a search, a read or asking for context: the trail of B3).
    `SELECT EXISTS (SELECT 1 FROM sessions s JOIN credentials c ON c.id = s.credential_id
                     WHERE s.brain_id = $1 AND c.kind <> 'web')
         OR EXISTS (SELECT 1 FROM proposals p JOIN credentials c ON c.id = p.credential_id
                     WHERE p.brain_id = $1 AND c.kind <> 'web')
         OR EXISTS (SELECT 1 FROM trail t JOIN credentials c ON c.id = t.credential_id
                     WHERE t.brain_id = $1 AND c.kind <> 'web'${mine ? ` AND ${mine.sql}` : ''}) AS agent,
            EXISTS (SELECT 1 FROM entries e WHERE e.brain_id = $1) AS entry`,
    mine ? [brain.id, mine.id] : [brain.id],
  )
  const h = await wikiHealth(ctx, slug)
  return {
    cursor,
    stats,
    todaySessions: sessions.map((r) => ({
      id: String(r.id),
      who: String(r.who),
      // The client that opened it, named then, as Sessions shows it (domain/clients.ts).
      client: r.client == null ? null : String(r.client),
      // The session of the day a key gets by writing without opening one has no purpose of its own.
      purpose: r.day == null ? String(r.purpose) : '',
      // Set for that session: its day (the web names it «Unnamed work»).
      day: dayText(r.day),
      ref: r.ref == null ? null : String(r.ref),
      status: String(r.status),
      entries: Number(r.entries),
      summary: r.summary == null ? null : String(r.summary).slice(0, SUMMARY_CHARS),
      openedAt: (r.opened_at as Date).toISOString(),
      lastActivityAt: (r.last_activity_at as Date).toISOString(),
    })),
    pending: pending.map((r) => ({ ...proposalOf(r, now), opCount: Number(r.op_count) })),
    health: {
      orphans: h.orphans.length,
      broken: h.broken.length,
      conflicts: h.conflicts.length,
      stale: h.stale.length,
      unavailableSources: h.unavailableSources.length,
      long: h.long.length,
      similarTitles: h.similarTitles.length,
    },
    // Importing a folder arrives with B7 (rsc-brain-install); until then it is never done.
    firstSteps: { agentConnected: Boolean(steps?.agent), firstEntry: Boolean(steps?.entry), imported: false },
  }
}
