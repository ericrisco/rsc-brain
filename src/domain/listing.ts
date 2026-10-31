// Reading the journal page by page (spec B1 «Leer el diario»). Every list says how many there are in
// total and gives a cursor for the next page. Forgotten and purged entries stay out of ordinary lists.
import { denied, invalid, notFound } from '../core/errors.ts'
import type { Row } from '../db/db.ts'
import { type Ctx, inBrain } from './context.ts'
import { type Byline, bylines, ENTRY_TYPES, type Entry, entryOf, withByline } from './entries.ts'
import { lastSeq } from './events.ts'
import { inConflict } from './relations.ts'
import { closeIdle, dayText, type Session, sessionOf } from './sessions.ts'

export type Page<T> = { items: T[]; total: number; next: string | null }

export const PAGE = { default: 50, max: 200 }

type Cursor = { at: string; id: string }

// Only what `encode` writes: a full ISO instant (Date.parse alone accepts "1" as a year).
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function decode(cursor: string | undefined): Cursor | null {
  if (!cursor) return null
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Cursor
    if (
      typeof c.at === 'string' &&
      typeof c.id === 'string' &&
      ISO.test(c.at) &&
      !Number.isNaN(Date.parse(c.at))
    )
      return c
  } catch {}
  throw invalid('The cursor is not valid.', 'Use the "next" value of the previous page, unchanged.')
}

export const encode = (at: Date, id: string) =>
  Buffer.from(JSON.stringify({ at: at.toISOString(), id })).toString('base64url')

export function limitOf(v: string | null | undefined): number {
  if (v == null || v === '') return PAGE.default
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > PAGE.max) {
    throw invalid(`"limit" must be between 1 and ${PAGE.max}.`, `Ask for at most ${PAGE.max} per page.`)
  }
  return n
}

// The sessions of a brain as the journal shows them (spec B6 «Journal › Sessions», plan G12): newest
// first, each with the client that wrote (the agent of a short key, the app of a connection, the program
// behind a token when it opened, or the web), its author, how many entries of work it holds (the summary aside),
// and its summary. Filters narrow both the page and its total.
export type SessionFilter = {
  status?: string
  client?: string
  author?: string
  ref?: string
  type?: string
  from?: Date
  to?: Date
  before?: Date
  uncompiled?: boolean
  cursor?: string
  limit?: number
}

export type SessionView = Session & {
  day: string | null
  client: string | null
  author: { id: string; name: string }
  entries: number
  // Its entries forgotten since (the summary aside, as in `entries`): the count of entries drops by them,
  // and the web says why.
  forgotten: number
  summary: string | null
}

export const SESSION_STATUSES = ['open', 'closed', 'closed_no_summary'] as const
const SUMMARY_CHARS = 300

// The client that opened it, named then (domain/clients.ts).
const CLIENT = 's.client'

const SESSION_SELECT = `SELECT s.*, a.name AS author_name, ${CLIENT} AS client, se.content AS summary_text,
    (SELECT count(*)::int FROM entries e WHERE e.session_id = s.id AND e.state = 'active'
        AND e.type <> 'summary') AS entry_count,
    (SELECT count(*)::int FROM entries e WHERE e.session_id = s.id AND e.state = 'forgotten'
        AND e.type <> 'summary') AS forgotten_count
   FROM sessions s JOIN accounts a ON a.id = s.account_id
   LEFT JOIN entries se ON se.id = s.summary_entry_id AND se.state = 'active'`

const sessionViewOf = (r: Row): SessionView => ({
  ...sessionOf(r),
  day: dayText(r.day),
  client: r.client == null ? null : String(r.client),
  author: { id: String(r.account_id), name: String(r.author_name) },
  entries: Number(r.entry_count),
  forgotten: Number(r.forgotten_count),
  summary: r.summary_text == null ? null : String(r.summary_text).slice(0, SUMMARY_CHARS),
})

// A part of a reference, as typed: % and _ match themselves.
const likeOf = (v: string) => `%${v.replace(/[\\%_]/g, (m) => `\\${m}`)}%`

export async function listSessions(
  ctx: Ctx,
  slug: string,
  f: SessionFilter,
): Promise<Page<SessionView> & { liveFrom: string; facets?: SessionFacets }> {
  const { brain } = await inBrain(ctx, { slug })
  if (f.status !== undefined && !(SESSION_STATUSES as readonly string[]).includes(f.status))
    throw invalid(`Unknown status "${f.status}".`, `Use one of: ${SESSION_STATUSES.join(', ')}.`)
  if (f.type !== undefined && !(ENTRY_TYPES as readonly string[]).includes(f.type))
    throw invalid(`Unknown entry type "${f.type}".`, `Use one of: ${ENTRY_TYPES.join(', ')}.`)
  await closeIdle(ctx.db, ctx.clock())
  // Read first: every event numbered up to here is already in what follows, so a live stream resumed
  // from this id misses nothing.
  const liveFrom = String(await lastSeq(ctx.db))
  const where = ['s.brain_id = $1']
  const params: unknown[] = [brain.id]
  const add = (sql: string, v: unknown) => {
    params.push(v)
    where.push(sql.replaceAll('?', `$${params.length}`))
  }
  if (f.status !== undefined) add('s.status = ?', f.status)
  if (f.client !== undefined) add(`${CLIENT} = ?`, f.client)
  if (f.author !== undefined) add('s.account_id = ?', f.author)
  if (f.ref !== undefined)
    add(
      `(s.ref ILIKE ? OR EXISTS (SELECT 1 FROM entries e WHERE e.session_id = s.id AND e.state = 'active'
          AND e.stamped_ref ILIKE ?))`,
      likeOf(f.ref),
    )
  if (f.type !== undefined)
    add(
      "EXISTS (SELECT 1 FROM entries e WHERE e.session_id = s.id AND e.state = 'active' AND e.type = ?)",
      f.type,
    )
  if (f.uncompiled)
    where.push(
      "EXISTS (SELECT 1 FROM entries e WHERE e.session_id = s.id AND e.state = 'active' AND NOT e.compiled AND e.type <> 'summary')",
    )
  // Dates: a session counts on every day it was active, from its opening to its last write.
  if (f.from !== undefined) add('s.last_activity_at >= ?', f.from)
  if (f.to !== undefined) add('s.opened_at <= ?', f.to)
  if (f.before !== undefined) add('s.opened_at < ?', f.before)
  const FROM = `FROM sessions s WHERE ${where.join(' AND ')}`
  const total = await ctx.db.one<{ n: number }>(`SELECT count(*)::int AS n ${FROM}`, params)
  const c = decode(f.cursor)
  const limit = f.limit ?? PAGE.default
  const n = params.length
  const rows = await ctx.db.query(
    `${SESSION_SELECT} WHERE ${where.join(' AND ')}
        AND ($${n + 1}::timestamptz IS NULL OR (s.opened_at, s.id) < ($${n + 1}, $${n + 2}))
      ORDER BY s.opened_at DESC, s.id DESC LIMIT $${n + 3}`,
    [...params, c?.at ?? null, c?.id ?? '', limit + 1],
  )
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map(sessionViewOf),
    total: total?.n ?? 0,
    next: rows.length > limit && last ? encode(last.opened_at as Date, String(last.id)) : null,
    liveFrom,
    // What the filters can pick from, with the first page: nobody types an id.
    ...(f.cursor ? {} : { facets: await facetsOf(ctx, brain.id) }),
  }
}

export type SessionFacets = { clients: string[]; authors: Array<{ id: string; name: string }> }

async function facetsOf(ctx: Ctx, brainId: string): Promise<SessionFacets> {
  const clients = await ctx.db.query<{ client: string }>(
    `SELECT DISTINCT ${CLIENT} AS client FROM sessions s WHERE s.brain_id = $1 AND ${CLIENT} IS NOT NULL
      ORDER BY 1 LIMIT 100`,
    [brainId],
  )
  const authors = await ctx.db.query<{ id: string; name: string }>(
    `SELECT DISTINCT a.id, a.name FROM sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.brain_id = $1 ORDER BY a.name, a.id LIMIT 100`,
    [brainId],
  )
  return { clients: clients.map((r) => r.client), authors: authors.map((r) => ({ id: r.id, name: r.name })) }
}

// One session, with the fields of the list; one in a brain the caller cannot read does not exist.
export async function sessionView(ctx: Ctx, id: string): Promise<SessionView> {
  const row = await ctx.db.one(`${SESSION_SELECT} WHERE s.id = $1`, [id])
  if (!row) throw notFound('session')
  await inBrain(ctx, { id: String(row.brain_id) }).catch(() => {
    throw notFound('session')
  })
  return sessionViewOf(row)
}

export type EntryFilter = { ref?: string; type?: string; sessionId?: string; cursor?: string; limit?: number }

// Each entry says whether an open conflict is about it (a badge in a session, spec B6).
export async function listEntries(
  ctx: Ctx,
  slug: string,
  f: EntryFilter,
): Promise<Page<Entry & { conflict: boolean }>> {
  const { brain } = await inBrain(ctx, { slug })
  const where = ['brain_id = $1', "state = 'active'"]
  const params: unknown[] = [brain.id]
  const add = (sql: string, v: unknown) => {
    params.push(v)
    where.push(sql.replace('?', `$${params.length}`))
  }
  // An entry belongs to a job's reference if any of its revisions was written by that job's key (a
  // later revision by someone else does not take it away, nor lend it that reference).
  if (f.ref !== undefined) {
    add(
      'EXISTS (SELECT 1 FROM entry_revisions rv WHERE rv.entry_id = entries.id AND rv.stamped_ref = ?)',
      f.ref,
    )
  }
  if (f.type !== undefined) add('type = ?', f.type)
  if (f.sessionId !== undefined) add('session_id = ?', f.sessionId)
  const total = await ctx.db.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM entries WHERE ${where.join(' AND ')}`,
    params,
  )
  const c = decode(f.cursor)
  const limit = f.limit ?? PAGE.default
  const pageParams = [...params, c?.at ?? null, c?.id ?? '', limit + 1]
  const n = params.length
  const rows = await ctx.db.query<Row>(
    `SELECT * FROM entries WHERE ${where.join(' AND ')}
        AND ($${n + 1}::timestamptz IS NULL OR (created_at, id) > ($${n + 1}, $${n + 2}))
      ORDER BY created_at, id LIMIT $${n + 3}`,
    pageParams,
  )
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  let items = page.map(entryOf)
  if (f.ref !== undefined && items.length > 0) {
    // Filtered by a job's reference, each entry shows what that job wrote (its last revision there),
    // not what someone added afterwards; `revision` says which one it is.
    const revs = await ctx.db.query(
      `SELECT DISTINCT ON (entry_id) * FROM entry_revisions
        WHERE entry_id = ANY($1) AND stamped_ref = $2 ORDER BY entry_id, revision DESC`,
      [items.map((e) => e.id), f.ref],
    )
    const byId = new Map(revs.map((r) => [String(r.entry_id), r]))
    items = items.map((e) => {
      const r = byId.get(e.id)
      if (!r) return e
      return {
        ...e,
        type: r.type as Entry['type'],
        title: String(r.title),
        content: String(r.content),
        appliesTo: r.applies_to == null ? null : String(r.applies_to),
        tags: (r.tags as string[]) ?? [],
        refs: (r.refs as string[]) ?? [],
        ref: f.ref ?? null,
        revision: Number(r.revision),
      }
    })
  }
  const open = await inConflict(
    ctx.db,
    items.map((e) => e.id),
  )
  return {
    items: items.map((e) => ({ ...e, conflict: open.has(e.id) })),
    total: total?.n ?? 0,
    next: rows.length > limit && last ? encode(last.created_at as Date, String(last.id)) : null,
  }
}

// The curator's lists and the views around one entry (spec B1 «Leer el diario»).
export type View = 'forgotten' | 'to-review' | 'uncompiled'

export async function listView(
  ctx: Ctx,
  slug: string,
  view: View,
  o: { limit?: number; cursor?: string } = {},
): Promise<Page<Entry & Byline>> {
  const { brain, role } = await inBrain(ctx, { slug })
  const limit = o.limit ?? PAGE.default
  const c = decode(o.cursor)
  let where: string
  if (view === 'forgotten') {
    if (role !== 'curator') {
      throw denied('Only curators see forgotten entries.', 'Ask a curator of the brain.')
    }
    where = "state = 'forgotten'"
  } else if (view === 'to-review') {
    where = "state = 'active' AND review_after IS NOT NULL AND review_after <= $2"
  } else {
    where = "state = 'active' AND NOT compiled AND type <> 'summary'"
  }
  const params = view === 'to-review' ? [brain.id, ctx.clock()] : [brain.id]
  const total = await ctx.db.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM entries WHERE brain_id = $1 AND ${where}`,
    params,
  )
  const n = params.length
  const rows = await ctx.db.query(
    `SELECT * FROM entries WHERE brain_id = $1 AND ${where}
        AND ($${n + 1}::timestamptz IS NULL OR (created_at, id) > ($${n + 1}, $${n + 2}))
      ORDER BY created_at, id LIMIT $${n + 3}`,
    [...params, c?.at ?? null, c?.id ?? '', limit + 1],
  )
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  // Who wrote each, and for the forgotten ones who forgot it and why (only curators see this list).
  const by = await bylines(
    ctx.db,
    page.map((r) => String(r.id)),
  )
  return {
    items: page.map((r) => withByline(entryOf(r), by.get(String(r.id)))),
    total: total?.n ?? 0,
    next: rows.length > limit && last ? encode(last.created_at as Date, String(last.id)) : null,
  }
}

// The entries just before and after one, in its session.
export async function around(
  ctx: Ctx,
  id: string,
  n: number,
): Promise<{ before: Entry[]; entry: Entry; after: Entry[] }> {
  const row = await ctx.db.one('SELECT * FROM entries WHERE id = $1', [id])
  if (!row) throw notFoundEntry()
  await inBrain(ctx, { id: String(row.brain_id) }).catch(() => {
    throw notFoundEntry()
  })
  if (row.state !== 'active') throw notFoundEntry()
  const before = await ctx.db.query(
    `SELECT * FROM entries WHERE session_id = $1 AND state = 'active' AND (created_at, id) < ($2, $3)
      ORDER BY created_at DESC, id DESC LIMIT $4`,
    [row.session_id, row.created_at, row.id, n],
  )
  const after = await ctx.db.query(
    `SELECT * FROM entries WHERE session_id = $1 AND state = 'active' AND (created_at, id) > ($2, $3)
      ORDER BY created_at, id LIMIT $4`,
    [row.session_id, row.created_at, row.id, n],
  )
  return { before: before.reverse().map(entryOf), entry: entryOf(row), after: after.map(entryOf) }
}

const notFoundEntry = () => notFound('entry')
