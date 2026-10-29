// Changing what is already in the journal (spec B1 «Corregir, olvidar y purgar», «Fijar, revisar y
// caducar»). Edits go against the revision the caller saw. Corrections — a person's words — are not
// changed or forgotten through the API: that is done by a person, in the web (pack rule 4).
import { createHash } from 'node:crypto'
import { conflict, invalid, notFound } from '../core/errors.ts'
import type { Db, Row } from '../db/db.ts'
import { normalize, redact, redactAll } from '../privacy/redact.ts'
import { audit } from './audit.ts'
import { addMember } from './brains.ts'
import { allow, type Ctx, type InBrain, inBrain, ok } from './context.ts'
import { ENTRY_TYPES, type Entry, entryOf, LIMITS } from './entries.ts'
import { emit } from './events.ts'

const PERSONS_ONLY = () =>
  invalid(
    'A correction is a person’s word; it is changed or forgotten by a person, in the web.',
    'Ask a curator of the brain to do it in the web, or write a new entry.',
  )

async function load(ctx: Ctx, db: Db, id: string): Promise<{ row: Row; at: InBrain }> {
  const row = await db.one('SELECT * FROM entries WHERE id = $1 FOR UPDATE', [id])
  if (!row) throw notFound('entry')
  const at = await inBrain({ ...ctx, db }, { id: String(row.brain_id) }, 'share').catch(() => {
    throw notFound('entry')
  })
  if (row.state === 'purged') throw notFound('entry')
  if (row.state === 'forgotten' && at.role !== 'curator') throw notFound('entry')
  return { row, at }
}

const isOwner = (ctx: Ctx, row: Row) => row.author_id === ctx.who.accountId

export type EntryEdit = {
  baseRevision: number
  type?: string
  title?: string
  content?: string
  appliesTo?: string | null
  tags?: string[]
  refs?: string[]
}

export async function editEntry(ctx: Ctx, id: string, e: EntryEdit): Promise<Entry> {
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const { row, at } = await load(ctx, db, id)
    await allow(
      c,
      'entry.edit',
      { role: at.role, isOwner: isOwner(ctx, row), brainStatus: at.brain.status },
      at.brain.id,
    )
    if (row.type === 'correction' || e.type === 'correction') throw PERSONS_ONLY()
    if (row.state !== 'active') {
      throw conflict(
        'entry_forgotten',
        'This entry is forgotten.',
        'Recover it first (curators), then edit it.',
      )
    }
    if (Number(row.revision) !== e.baseRevision) {
      const err = conflict(
        'entry_changed',
        `The entry changed since revision ${e.baseRevision}; it is now at revision ${row.revision}.`,
        'Read the current version (in "current"), apply your change to it and send it with its revision.',
      )
      err.current = entryOf(row)
      throw err
    }
    const type = e.type ?? String(row.type)
    if (!(ENTRY_TYPES as readonly string[]).includes(type)) {
      throw invalid(`Unknown entry type "${type}".`, `Use one of: ${ENTRY_TYPES.join(', ')}.`)
    }
    const title = (e.title ?? String(row.title)).trim()
    const content = e.content ?? String(row.content)
    if (!title || title.length > LIMITS.title)
      throw invalid(`A title has 1 to ${LIMITS.title} characters.`, 'Fix it.')
    if (!content.trim() || content.length > LIMITS.content) {
      throw invalid(`Content has 1 to ${LIMITS.content} characters.`, 'Split it into several entries.')
    }
    const r = redactAll({
      title,
      content,
      appliesTo: e.appliesTo === undefined ? (row.applies_to as string | null) : e.appliesTo,
      tags: e.tags ?? (row.tags as string[]),
      refs: e.refs ?? (row.refs as string[]),
    })
    const now = ctx.clock()
    const revision = Number(row.revision) + 1
    const f = r.fields
    const norm = createHash('sha256')
      .update(normalize(`${f.title}\n${f.content}`))
      .digest('hex')
    const updated = await db.one(
      `UPDATE entries SET type = $2, title = $3, content = $4, applies_to = $5, tags = $6, refs = $7, revision = $8,
              norm_hash = $9, updated_at = $10 WHERE id = $1 RETURNING *`,
      [id, type, f.title, f.content, f.appliesTo, f.tags, f.refs, revision, norm, now],
    )
    await db.query(
      `INSERT INTO entry_revisions (entry_id, revision, type, title, content, applies_to, tags, refs, author_id, credential_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        revision,
        type,
        f.title,
        f.content,
        f.appliesTo,
        f.tags,
        f.refs,
        ctx.who.accountId,
        ctx.who.credential.id,
        now,
      ],
    )
    await emit(db, c, { brainId: at.brain.id, kind: 'entry.changed', targetId: id, label: String(f.title) })
    return entryOf(updated as Row)
  })
}

export async function forgetEntry(ctx: Ctx, id: string, reason: string): Promise<Entry> {
  const why = redact(reason.trim()).text
  if (!why || why.length > 500) throw invalid('Say why, in 1 to 500 characters.', 'Add a short reason.')
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const { row, at } = await load(ctx, db, id)
    await allow(
      c,
      'entry.forget',
      { role: at.role, isOwner: isOwner(ctx, row), brainStatus: at.brain.status },
      at.brain.id,
    )
    if (row.type === 'correction') throw PERSONS_ONLY()
    if (row.state === 'forgotten') return entryOf(row)
    const out = await db.one(
      `UPDATE entries SET state = 'forgotten', forgotten_by = $2, forgotten_reason = $3, forgotten_at = $4, updated_at = $4
        WHERE id = $1 RETURNING *`,
      [id, ctx.who.accountId, why, ctx.clock()],
    )
    await emit(db, c, { brainId: at.brain.id, kind: 'entry.changed', targetId: id, label: 'forgotten' })
    return entryOf(out as Row)
  })
}

export async function recoverEntry(ctx: Ctx, id: string): Promise<Entry> {
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const { row, at } = await load(ctx, db, id)
    await allow(c, 'entry.pin', { role: at.role, brainStatus: at.brain.status }, at.brain.id)
    if (row.state === 'active') return entryOf(row)
    if (row.topic != null) {
      const taken = await db.one(
        "SELECT id FROM entries WHERE brain_id = $1 AND topic = $2 AND state = 'active'",
        [row.brain_id, row.topic],
      )
      if (taken) {
        throw conflict(
          'topic_taken',
          `Another entry (${taken.id}) now holds the topic "${row.topic}".`,
          'Forget that entry first, or keep this one forgotten.',
        )
      }
    }
    const out = await db.one(
      `UPDATE entries SET state = 'active', forgotten_by = NULL, forgotten_reason = NULL, forgotten_at = NULL, updated_at = $2
        WHERE id = $1 RETURNING *`,
      [id, ctx.clock()],
    )
    await emit(db, c, { brainId: at.brain.id, kind: 'entry.changed', targetId: id, label: 'recovered' })
    return entryOf(out as Row)
  })
}

export async function pinEntry(ctx: Ctx, id: string, pinned: boolean): Promise<Entry> {
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const { row, at } = await load(ctx, db, id)
    await allow(c, 'entry.pin', { role: at.role, brainStatus: at.brain.status }, at.brain.id)
    if (row.state !== 'active')
      throw conflict('entry_forgotten', 'This entry is forgotten.', 'Recover it first.')
    const out = await db.one('UPDATE entries SET pinned = $2, updated_at = $3 WHERE id = $1 RETURNING *', [
      id,
      pinned,
      ctx.clock(),
    ])
    return entryOf(out as Row)
  })
}

function when(v: string | null | undefined, field: string): Date | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  const d = new Date(v)
  if (Number.isNaN(d.getTime()))
    throw invalid(`"${field}" is not a date.`, 'Send an ISO date, or null to clear it.')
  return d
}

// Review-after and expiry dates: the author or a curator.
export async function scheduleEntry(
  ctx: Ctx,
  id: string,
  s: { reviewAfter?: string | null; expiresAt?: string | null },
): Promise<Entry> {
  const review = when(s.reviewAfter, 'reviewAfter')
  const expires = when(s.expiresAt, 'expiresAt')
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const { row, at } = await load(ctx, db, id)
    await allow(
      c,
      'entry.edit',
      { role: at.role, isOwner: isOwner(ctx, row), brainStatus: at.brain.status },
      at.brain.id,
    )
    const out = await db.one(
      `UPDATE entries SET review_after = CASE WHEN $2 THEN $3::timestamptz ELSE review_after END,
              expires_at = CASE WHEN $4 THEN $5::timestamptz ELSE expires_at END, updated_at = $6
        WHERE id = $1 RETURNING *`,
      [id, review !== undefined, review ?? null, expires !== undefined, expires ?? null, ctx.clock()],
    )
    return entryOf(out as Row)
  })
}

// Purge: the administration, as a member of the brain (it joins as a reader if it is not one, which
// the brain's curators see). Content and history go; every derived copy goes with them (pack rule 2);
// a visible mark stays. Backups taken before keep the content until they rotate.
export async function purgeEntry(
  ctx: Ctx,
  id: string,
  reason: string,
): Promise<{ entry: Entry; joined: boolean; backupsNote: string }> {
  await allow(ctx, 'entry.purge', {})
  const why = redact(reason.trim()).text
  if (!why || why.length > 500)
    throw invalid('Write why it is purged, in 1 to 500 characters.', 'Add the reason.')
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const row = await db.one('SELECT * FROM entries WHERE id = $1 FOR UPDATE', [id])
    if (!row) throw notFound('entry')
    const brainId = String(row.brain_id)
    const member = await db.one('SELECT role FROM memberships WHERE brain_id = $1 AND account_id = $2', [
      brainId,
      ctx.who.accountId,
    ])
    let joined = false
    if (!member) {
      await addMember(db, brainId, ctx.who.accountId, 'reader', ctx.clock())
      await ok(c, 'admin.join', brainId, ctx.who.accountId, 'joined to purge an entry')
      await emit(db, c, {
        brainId,
        kind: 'entry.changed',
        targetId: null,
        label: `${ctx.who.name} (administration) joined`,
      })
      joined = true
    }
    if (row.state !== 'purged') {
      const now = ctx.clock()
      await db.query(
        `UPDATE entries SET state = 'purged', title = '[purged]', content = '', applies_to = NULL, tags = '{}', refs = '{}',
                topic = NULL, pinned = false, purged_by = $2, purged_reason = $3, purged_at = $4, updated_at = $4
          WHERE id = $1`,
        [id, ctx.who.accountId, why, now],
      )
      await db.query('DELETE FROM entry_revisions WHERE entry_id = $1', [id])
      await db.query('DELETE FROM trail WHERE $1 = ANY(result_ids)', [id])
      await db.query('DELETE FROM events WHERE target_id = $1', [id])
      await db.query('DELETE FROM request_keys WHERE receipt::text LIKE $1', [`%${id}%`])
      await audit(db, {
        at: now,
        actorId: ctx.who.accountId,
        credentialId: ctx.who.credential.id,
        action: 'entry.purge',
        brainId,
        target: id,
        outcome: 'ok',
        detail: why,
      })
    }
    const out = await db.one('SELECT * FROM entries WHERE id = $1', [id])
    return {
      entry: entryOf(out as Row),
      joined,
      backupsNote: 'Backups taken before this purge still hold the content until they rotate out.',
    }
  })
}
