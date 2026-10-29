// Reading the journal page by page (spec B1 «Leer el diario»). Every list says how many there are in
// total and gives a cursor for the next page. Forgotten and purged entries stay out of ordinary lists.
import { invalid, notFound } from '../core/errors.ts'
import type { Row } from '../db/db.ts'
import { type Ctx, inBrain } from './context.ts'
import { type Entry, entryOf } from './entries.ts'
import { closeIdle, type Session, sessionOf } from './sessions.ts'

export type Page<T> = { items: T[]; total: number; next: string | null }

export const PAGE = { default: 50, max: 200 }

type Cursor = { at: string; id: string }

function decode(cursor: string | undefined): Cursor | null {
  if (!cursor) return null
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Cursor
    if (typeof c.at === 'string' && typeof c.id === 'string' && !Number.isNaN(Date.parse(c.at))) return c
  } catch {}
  throw invalid('The cursor is not valid.', 'Use the "next" value of the previous page, unchanged.')
}

const encode = (at: Date, id: string) =>
  Buffer.from(JSON.stringify({ at: at.toISOString(), id })).toString('base64url')

export function limitOf(v: string | null | undefined): number {
  if (v == null || v === '') return PAGE.default
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > PAGE.max) {
    throw invalid(`"limit" must be between 1 and ${PAGE.max}.`, `Ask for at most ${PAGE.max} per page.`)
  }
  return n
}

export async function listSessions(
  ctx: Ctx,
  slug: string,
  o: { cursor?: string; limit?: number },
): Promise<Page<Session>> {
  const { brain } = await inBrain(ctx, { slug })
  await closeIdle(ctx.db, ctx.clock())
  const c = decode(o.cursor)
  const limit = o.limit ?? PAGE.default
  const rows = await ctx.db.query(
    `SELECT * FROM sessions WHERE brain_id = $1 AND ($2::timestamptz IS NULL OR (opened_at, id) < ($2, $3))
      ORDER BY opened_at DESC, id DESC LIMIT $4`,
    [brain.id, c?.at ?? null, c?.id ?? '', limit + 1],
  )
  const total = await ctx.db.one<{ n: number }>(
    'SELECT count(*)::int AS n FROM sessions WHERE brain_id = $1',
    [brain.id],
  )
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map(sessionOf),
    total: total?.n ?? 0,
    next: rows.length > limit && last ? encode(last.opened_at as Date, String(last.id)) : null,
  }
}

export type EntryFilter = { ref?: string; type?: string; sessionId?: string; cursor?: string; limit?: number }

export async function listEntries(ctx: Ctx, slug: string, f: EntryFilter): Promise<Page<Entry>> {
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
  return {
    items,
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
  o: { limit?: number } = {},
): Promise<Page<Entry>> {
  const { brain, role } = await inBrain(ctx, { slug })
  const limit = o.limit ?? PAGE.default
  let where: string
  if (view === 'forgotten') {
    if (role !== 'curator') {
      throw invalid('Only curators see forgotten entries.', 'Ask a curator of the brain.')
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
  const rows = await ctx.db.query(
    `SELECT * FROM entries WHERE brain_id = $1 AND ${where} ORDER BY created_at, id LIMIT ${limit}`,
    params,
  )
  return { items: rows.map(entryOf), total: total?.n ?? 0, next: null }
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
