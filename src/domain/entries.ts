// Saving to the journal (spec B1 «Entradas», «Temas», «Duplicados y reintentos», «Privacidad»).
// One transaction per save: redact, check the request key, resolve the session, then either revise
// the topic's entry, count a repetition, or insert a new entry; the receipt is stored with the
// request key so a retry gets the very same receipt.
import { createHash } from 'node:crypto'
import { memberRole } from '../auth/principal.ts'
import { conflict, invalid, notFound } from '../core/errors.ts'
import { newId } from '../core/ids.ts'
import type { Db, Row } from '../db/db.ts'
import { normalize, redactAll } from '../privacy/redact.ts'
import { clientNow } from './clients.ts'
import { allow, type Ctx, inBrain } from './context.ts'
import { emit } from './events.ts'
import { dayText, ownsSession, sessionFor, touch } from './sessions.ts'
import { track } from './trail.ts'
import { pageNotFound } from './wiki/pages.ts'

export const ENTRY_TYPES = [
  'decision',
  'learning',
  'attempt',
  'correction',
  'preference',
  'fact',
  'step',
  'summary',
  'note',
] as const
export type EntryType = (typeof ENTRY_TYPES)[number]

export const LIMITS = { title: 200, content: 32_000, tag: 40, tags: 20, ref: 500, refs: 20, appliesTo: 80 }
export const DEDUP_WINDOW_MS = 15 * 60 * 1000
export const TOPIC = /^[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*$/

export type EntryInput = {
  type: string
  title: string
  content: string
  topic?: string
  appliesTo?: string
  tags?: string[]
  refs?: string[]
  reviewAfter?: string
  expiresAt?: string
  sessionId?: string
  requestKey?: string
}

export type Similar = { entryId: string; title: string; why: 'topic' | 'words' }

export type Receipt = {
  entryId: string
  revision: number
  at: string
  deduplicated: boolean
  repeatCount: number
  redactions: number
  topicNote?: string
  similar: Similar[]
}

function date(v: string | undefined, field: string): Date | null {
  if (v === undefined) return null
  const d = new Date(v)
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1 || d.getUTCFullYear() > 9999)
    throw invalid(`"${field}" is not a date.`, 'Send an ISO date such as 2026-11-30.')
  return d
}

// The checks that say exactly what is wrong (spec B1 «Bordes y errores»).
export function validate(i: EntryInput): void {
  if (!(ENTRY_TYPES as readonly string[]).includes(i.type)) {
    throw invalid(`Unknown entry type "${i.type}".`, `Use one of: ${ENTRY_TYPES.join(', ')}.`)
  }
  const title = i.title.trim()
  if (!title) throw invalid('An entry needs a title.', 'Give it a one-line title.')
  if (title.length > LIMITS.title) {
    throw invalid(`The title is longer than ${LIMITS.title} characters.`, 'Make it one short line.')
  }
  if (!i.content.trim())
    throw invalid('An entry needs content.', 'Say what, why, where and what you learned.')
  if (i.content.length > LIMITS.content) {
    throw invalid(
      `The content is longer than ${LIMITS.content} characters.`,
      'Split it into several entries, or save a reference to where the full text lives.',
    )
  }
  if (i.topic !== undefined && (!TOPIC.test(i.topic) || i.topic.length > 200)) {
    throw invalid(
      `"${i.topic}" is not a valid topic.`,
      `A topic is lowercase words with hyphens, levels split by "/", e.g. "style/intro-length". Suggested: "${suggestKey(i.topic)}".`,
    )
  }
  if ((i.tags?.length ?? 0) > LIMITS.tags || i.tags?.some((t) => !t.trim() || t.length > LIMITS.tag)) {
    throw invalid(
      `Up to ${LIMITS.tags} tags of up to ${LIMITS.tag} characters.`,
      'Remove or shorten some tags.',
    )
  }
  if ((i.refs?.length ?? 0) > LIMITS.refs || i.refs?.some((r) => !r.trim() || r.length > LIMITS.ref)) {
    throw invalid(
      `Up to ${LIMITS.refs} references of up to ${LIMITS.ref} characters.`,
      'Remove or shorten some.',
    )
  }
  if (i.appliesTo !== undefined && (!i.appliesTo.trim() || i.appliesTo.length > LIMITS.appliesTo)) {
    throw invalid(`"appliesTo" has 1 to ${LIMITS.appliesTo} characters.`, 'Name the agent, e.g. "narrator".')
  }
}

// A topic key from free text: lowercase, accents gone, words joined by hyphens.
export function suggestKey(text: string): string {
  const levels = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split('/')
    .map((l) =>
      l
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60),
    )
    .filter(Boolean)
  return levels.join('/') || 'note'
}

const STOP = new Set(
  'a an and are as at be by for from has have in is it its of on or that the this to was were will with de del el en es la las los para por que se un una y o al lo como mas pero sus le ya'.split(
    ' ',
  ),
)

// The significant words of a text (for "similar entries" without meaning search).
export function words(text: string): string[] {
  const out = new Set<string>()
  for (const w of text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)) {
    if (w.length >= 3 && !STOP.has(w)) out.add(w)
  }
  return [...out].slice(0, 40)
}

// Up to five entries of the brain that may be about the same thing: the topic's own entry, then the
// ones sharing at least two significant words, most shared first.
async function similarTo(
  db: Db,
  brainId: string,
  exceptId: string,
  topic: string | null,
  text: string,
): Promise<Similar[]> {
  const ws = words(text)
  if (ws.length === 0) return []
  const rows = await db.query<{ id: string; title: string; shared: number }>(
    `SELECT e.id, e.title,
            (SELECT count(*) FROM unnest(tsvector_to_array(to_tsvector('simple', brain_unaccent(e.title || ' ' || e.content)))) l
              WHERE l = ANY($3::text[]))::int AS shared
       FROM entries e
      WHERE e.brain_id = $1 AND e.id <> $2 AND e.state = 'active'
        AND e.search @@ to_tsquery('simple', $4)
      ORDER BY shared DESC, e.created_at DESC
      LIMIT 20`,
    [brainId, exceptId, ws, ws.join(' | ')],
  )
  const out: Similar[] = []
  if (topic) {
    const t = await db.one<{ id: string; title: string }>(
      "SELECT id, title FROM entries WHERE brain_id = $1 AND topic = $2 AND state = 'active' AND id <> $3",
      [brainId, topic, exceptId],
    )
    if (t) out.push({ entryId: t.id, title: t.title, why: 'topic' })
  }
  for (const r of rows) {
    if (out.length >= 5) break
    if (r.shared >= 2 && !out.some((s) => s.entryId === r.id))
      out.push({ entryId: r.id, title: r.title, why: 'words' })
  }
  return out
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

// The same receipt, field for field and in the same order, whether fresh or replayed.
function canonical(r: Receipt): Receipt {
  const out: Receipt = {
    entryId: r.entryId,
    revision: r.revision,
    at: r.at,
    deduplicated: r.deduplicated,
    repeatCount: r.repeatCount,
    redactions: r.redactions,
    similar: r.similar.map((s) => ({ entryId: s.entryId, title: s.title, why: s.why })),
  }
  if (r.topicNote) out.topicNote = r.topicNote
  return out
}

type Prepared = {
  type: EntryType
  title: string
  content: string
  topic: string | null
  appliesTo: string | null
  tags: string[]
  refs: string[]
  reviewAfter: Date | null
  expiresAt: Date | null
  redactions: number
}

// Redaction marks can make a text longer; what is stored must still fit every limit.
export function fitsOnceRedacted(f: Record<string, unknown>): void {
  const tooLong =
    (f.title as string).length > LIMITS.title ||
    (f.content as string).length > LIMITS.content ||
    ((f.appliesTo as string | null) ?? '').length > LIMITS.appliesTo ||
    (f.tags as string[]).some((t) => t.length > LIMITS.tag) ||
    (f.refs as string[]).some((t) => t.length > LIMITS.ref)
  if (tooLong) {
    throw invalid(
      'Once secrets are replaced by their marks, the text is longer than the limit.',
      'Shorten the text, or remove the secrets yourself.',
    )
  }
}

function prepare(i: EntryInput): Prepared {
  validate(i)
  const r = redactAll({
    title: i.title.trim(),
    content: i.content,
    appliesTo: i.appliesTo?.trim() ?? null,
    tags: (i.tags ?? []).map((t) => t.trim()),
    refs: (i.refs ?? []).map((t) => t.trim()),
  })
  fitsOnceRedacted(r.fields)
  return {
    type: i.type as EntryType,
    title: r.fields.title as string,
    content: r.fields.content as string,
    topic: i.topic ?? null,
    appliesTo: (r.fields.appliesTo as string | null) ?? null,
    tags: r.fields.tags as string[],
    refs: r.fields.refs as string[],
    reviewAfter: date(i.reviewAfter, 'reviewAfter'),
    expiresAt: date(i.expiresAt, 'expiresAt'),
    redactions: r.redactions,
  }
}

type Writer = { onBehalfId: string | null }

// An agent's own writing: a short key "on behalf of" a person signs it for that person (spec B4 CA20, «RSC
// Factory (run r_x, step 3) on behalf of Eric»); any other key speaks for nobody else.
const agentWriter = (ctx: Ctx): Writer => ({ onBehalfId: ctx.who.credential.onBehalfId ?? null })

// The heart of saving, shared by agents (`saveEntry`) and by the correction relay.
async function write(
  ctx: Ctx,
  db: Db,
  brainId: string,
  p: Prepared,
  w: Writer,
  o: { sessionId?: string; requestKey?: string },
): Promise<Receipt> {
  const c = { ...ctx, db }
  const now = ctx.clock()
  const who = ctx.who
  let requestHash: string | null = null
  let keyHash: string | null = null
  if (o.requestKey !== undefined) {
    if (!o.requestKey.trim() || o.requestKey.length > 200) {
      throw invalid(
        'A request key has 1 to 200 characters.',
        'Use a fresh random id per request, e.g. a UUID.',
      )
    }
    // Same key, same redacted request: the same receipt. Two retries racing are serialised here.
    requestHash = sha(JSON.stringify([brainId, p, w.onBehalfId, o.sessionId ?? null]))
    // Only the key's hash is kept: a client could use anything, even a secret, as its key.
    keyHash = sha(o.requestKey)
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${who.credential.id}:${keyHash}`,
    ])
    const seen = await db.one<{ request_hash: string; receipt: Receipt }>(
      'SELECT request_hash, receipt FROM request_keys WHERE credential_id = $1 AND key = $2',
      [who.credential.id, keyHash],
    )
    if (seen) {
      if (seen.request_hash === requestHash) return canonical(seen.receipt)
      throw conflict(
        'request_key_reused',
        'This request key was already used for a different request.',
        'Use a new request key for a new entry; reuse a key only to retry the very same request.',
      )
    }
  }
  const sessionId = await sessionFor(db, c, brainId, o.sessionId)
  // The client writing, named now: it stays with the entry whatever uses this key later.
  const client = await clientNow(db, who)
  const stampedRef = who.credential.kind === 'short' ? who.credential.ref : null
  const normHash = sha(normalize(`${p.title}\n${p.content}`))
  const by = {
    authorId: who.accountId,
    credentialId: who.credential.id,
    onBehalfId: w.onBehalfId,
    stampedRef,
  }
  let receipt: Receipt
  let topicNote: string | undefined

  const existingTopic = p.topic
    ? await (async () => {
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `topic:${brainId}:${p.topic}`,
        ])
        return db.one(
          "SELECT * FROM entries WHERE brain_id = $1 AND topic = $2 AND state = 'active' FOR UPDATE",
          [brainId, p.topic],
        )
      })()
    : undefined

  if (existingTopic) {
    const revision = Number(existingTopic.revision) + 1
    await db.query(
      `UPDATE entries SET type = $2, title = $3, content = $4, applies_to = $5, tags = $6, refs = $7,
              revision = $8, norm_hash = $9, review_after = $10, expires_at = $11, updated_at = $12,
              session_id = $13, credential_id = $14, on_behalf_id = $15, stamped_ref = $16, client = $17
        WHERE id = $1`,
      [
        existingTopic.id,
        p.type,
        p.title,
        p.content,
        p.appliesTo,
        p.tags,
        p.refs,
        revision,
        normHash,
        p.reviewAfter,
        p.expiresAt,
        now,
        sessionId,
        who.credential.id,
        w.onBehalfId,
        stampedRef,
        client,
      ],
    )
    await revisionRow(db, String(existingTopic.id), revision, p, by, now)
    await emit(db, c, { brainId, kind: 'entry.revised', targetId: String(existingTopic.id), label: p.title })
    receipt = {
      entryId: String(existingTopic.id),
      revision,
      at: now.toISOString(),
      deduplicated: false,
      repeatCount: Number(existingTopic.repeat_count),
      redactions: p.redactions,
      similar: [],
    }
  } else {
    // A repetition is the same account saying the same thing again: same type, same person it speaks
    // for, same job (stamped reference), within 15 minutes. Summaries are never merged. The advisory
    // lock makes two identical saves at once count as one and a repetition.
    let dup: Row | undefined
    if (!p.topic && p.type !== 'summary') {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `dedup:${brainId}:${who.accountId}:${normHash}`,
      ])
      dup = await db.one(
        `SELECT id, revision, repeat_count FROM entries
          WHERE brain_id = $1 AND author_id = $2 AND norm_hash = $3 AND topic IS NULL AND state = 'active'
            AND type = $6 AND on_behalf_id IS NOT DISTINCT FROM $7 AND stamped_ref IS NOT DISTINCT FROM $8
            AND created_at > $4::timestamptz - make_interval(secs => $5)
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [brainId, who.accountId, normHash, now, DEDUP_WINDOW_MS / 1000, p.type, w.onBehalfId, stampedRef],
      )
    }
    if (dup) {
      const row = await db.one<{ repeat_count: number }>(
        'UPDATE entries SET repeat_count = repeat_count + 1, updated_at = $2 WHERE id = $1 RETURNING repeat_count',
        [dup.id, now],
      )
      await emit(db, c, { brainId, kind: 'entry.repeated', targetId: String(dup.id), label: p.title })
      receipt = {
        entryId: String(dup.id),
        revision: Number(dup.revision),
        at: now.toISOString(),
        deduplicated: true,
        repeatCount: Number(row?.repeat_count),
        redactions: p.redactions,
        similar: [],
      }
    } else {
      if (p.topic) {
        const gone = await db.one(
          "SELECT 1 FROM entries WHERE brain_id = $1 AND topic = $2 AND state <> 'active' LIMIT 1",
          [brainId, p.topic],
        )
        if (gone) topicNote = 'the previous entry for this topic was forgotten; a new one was created'
      }
      const id = newId('ent')
      await db.query(
        `INSERT INTO entries (id, brain_id, session_id, type, topic, title, content, applies_to, tags, refs, author_id,
           credential_id, on_behalf_id, stamped_ref, norm_hash, review_after, expires_at, created_at, updated_at, client)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18,$19)`,
        [
          id,
          brainId,
          sessionId,
          p.type,
          p.topic,
          p.title,
          p.content,
          p.appliesTo,
          p.tags,
          p.refs,
          who.accountId,
          who.credential.id,
          w.onBehalfId,
          stampedRef,
          normHash,
          p.reviewAfter,
          p.expiresAt,
          now,
          client,
        ],
      )
      await revisionRow(db, id, 1, p, by, now)
      await emit(db, c, { brainId, kind: 'entry.saved', targetId: id, label: p.title })
      receipt = {
        entryId: id,
        revision: 1,
        at: now.toISOString(),
        deduplicated: false,
        repeatCount: 1,
        redactions: p.redactions,
        similar: [],
      }
    }
  }
  receipt.similar = await similarTo(db, brainId, receipt.entryId, p.topic, `${p.title} ${p.content}`)
  if (topicNote) receipt.topicNote = topicNote
  await touch(db, sessionId, now)
  if (keyHash && requestHash) {
    await db.query(
      'INSERT INTO request_keys (credential_id, key, request_hash, receipt, created_at) VALUES ($1, $2, $3, $4, $5)',
      [who.credential.id, keyHash, requestHash, JSON.stringify(receipt), now],
    )
  }
  return canonical(receipt)
}

async function revisionRow(
  db: Db,
  entryId: string,
  revision: number,
  p: Prepared,
  by: { authorId: string; credentialId: string; onBehalfId: string | null; stampedRef: string | null },
  at: Date,
): Promise<void> {
  await db.query(
    `INSERT INTO entry_revisions (entry_id, revision, type, title, content, applies_to, tags, refs, author_id,
       credential_id, on_behalf_id, stamped_ref, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      entryId,
      revision,
      p.type,
      p.title,
      p.content,
      p.appliesTo,
      p.tags,
      p.refs,
      by.authorId,
      by.credentialId,
      by.onBehalfId,
      by.stampedRef,
      at,
    ],
  )
}

export async function saveEntry(ctx: Ctx, slug: string, input: EntryInput): Promise<Receipt> {
  if (input.type === 'correction') {
    throw invalid(
      'Agents cannot write corrections; only people can.',
      'Save it as a "learning" or "preference" entry instead.',
    )
  }
  const p = prepare(input)
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const { brain, role } = await inBrain(c, { slug }, 'share')
    await allow(c, 'journal.write', { role, brainStatus: brain.status }, brain.id)
    return write(ctx, db, brain.id, p, agentWriter(ctx), compactO(input))
  })
}

const compactO = (i: { sessionId?: string; requestKey?: string }) => ({
  ...(i.sessionId !== undefined ? { sessionId: i.sessionId } : {}),
  ...(i.requestKey !== undefined ? { requestKey: i.requestKey } : {}),
})

// A person's correction written in the web, inside a transaction the caller holds: a curator returning
// a wiki proposal leaves the reason as a correction for the agent that proposed (spec B2 «Devolver»).
export async function webCorrection(
  ctx: Ctx,
  db: Db,
  brainId: string,
  input: { title: string; content: string; appliesTo?: string; refs?: string[] },
): Promise<Receipt> {
  if (ctx.who.credential.kind !== 'web' || ctx.who.kind !== 'person') {
    throw invalid('Only a person in the web writes corrections this way.', 'Use the rsc-brain web.')
  }
  return write(
    { ...ctx, db },
    db,
    brainId,
    prepare({ ...input, type: 'correction' }),
    { onBehalfId: null },
    {},
  )
}

// A person's correction, written by that person in the web (spec B6 «Add a correction», B1): about a
// page of the wiki or an entry of the journal, which it names in its references ("page:<address>",
// "entry:<id>"), and optionally addressed to an agent. It enters the context of the agents it touches
// (B3): the one it applies to, and any agent whose task is about its page or its words.
export async function addCorrection(
  ctx: Ctx,
  slug: string,
  input: {
    title: string
    content: string
    appliesTo?: string
    page?: string
    entry?: string
    requestKey?: string
  },
): Promise<Receipt> {
  if (input.page !== undefined && input.entry !== undefined)
    throw invalid('A correction is about one page or one entry, not both.', 'Send "page" or "entry".')
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const { brain, role } = await inBrain(c, { slug }, 'share')
    await allow(c, 'correction.write', { role, brainStatus: brain.status }, brain.id)
    const refs: string[] = []
    if (input.page !== undefined) {
      const page = await db.one<{ address: string }>(
        "SELECT address FROM pages WHERE brain_id = $1 AND address = $2 AND status <> 'retired'",
        [brain.id, input.page.trim()],
      )
      if (!page) throw pageNotFound(input.page.trim())
      refs.push(`page:${page.address}`)
    }
    if (input.entry !== undefined) {
      const e = await db.one<{ id: string }>(
        "SELECT id FROM entries WHERE id = $1 AND brain_id = $2 AND state = 'active'",
        [input.entry.trim(), brain.id],
      )
      if (!e) throw notFound('entry')
      refs.push(`entry:${e.id}`)
    }
    const p = prepare({
      type: 'correction',
      title: input.title,
      content: input.content,
      refs,
      ...(input.appliesTo?.trim() ? { appliesTo: input.appliesTo.trim() } : {}),
    })
    return write(ctx, db, brain.id, p, { onBehalfId: null }, compactO(input))
  })
}

// A person's correction, relayed by a service account with its main key (Factory's gate). The person
// must be an active contributor or curator of the brain; corrections never carry a topic.
export async function relayCorrection(
  ctx: Ctx,
  slug: string,
  input: Omit<EntryInput, 'type' | 'topic'> & { onBehalf: string },
): Promise<Receipt> {
  const p = prepare({ ...input, type: 'correction' })
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const { brain, role } = await inBrain(c, { slug }, 'share')
    const person = await db.one<{ id: string }>(
      `SELECT id FROM accounts WHERE (id = $1 OR email = lower($1)) AND kind = 'person' AND status = 'active'`,
      [input.onBehalf.trim()],
    )
    const onBehalfRole = person ? await memberRole(db, brain.id, person.id) : null
    await allow(c, 'correction.relay', { role, brainStatus: brain.status, onBehalfRole }, brain.id)
    return write(ctx, db, brain.id, p, { onBehalfId: person?.id ?? null }, compactO(input))
  })
}

export async function suggestTopic(
  ctx: Ctx,
  slug: string,
  title: string,
): Promise<{ suggested: string; similar: { topic: string; title: string }[] }> {
  const { brain } = await inBrain(ctx, { slug })
  const suggested = suggestKey(title)
  const ws = words(title)
  const rows = ws.length
    ? await ctx.db.query<{ topic: string; title: string }>(
        `SELECT topic, title FROM entries
          WHERE brain_id = $1 AND topic IS NOT NULL AND state = 'active'
            AND (to_tsvector('simple', brain_unaccent(replace(replace(topic, '/', ' '), '-', ' ') || ' ' || title))
                 @@ to_tsquery('simple', $2))
          ORDER BY updated_at DESC LIMIT 5`,
        [brain.id, ws.join(' | ')],
      )
    : []
  return { suggested, similar: rows }
}

export type Entry = {
  id: string
  brainId: string
  sessionId: string
  type: EntryType
  topic: string | null
  title: string
  content: string
  appliesTo: string | null
  tags: string[]
  refs: string[]
  authorId: string
  onBehalfId: string | null
  ref: string | null
  revision: number
  repeatCount: number
  pinned: boolean
  reviewAfter: string | null
  expiresAt: string | null
  state: 'active' | 'forgotten' | 'purged'
  supersededBy: string | null
  compiled: boolean
  createdAt: string
  updatedAt: string
}

const iso = (v: unknown) => (v == null ? null : (v as Date).toISOString())

export const entryOf = (r: Row): Entry => ({
  id: String(r.id),
  brainId: String(r.brain_id),
  sessionId: String(r.session_id),
  type: r.type as EntryType,
  topic: r.topic == null ? null : String(r.topic),
  title: String(r.title),
  content: String(r.content),
  appliesTo: r.applies_to == null ? null : String(r.applies_to),
  tags: (r.tags as string[]) ?? [],
  refs: (r.refs as string[]) ?? [],
  authorId: String(r.author_id),
  onBehalfId: r.on_behalf_id == null ? null : String(r.on_behalf_id),
  ref: r.stamped_ref == null ? null : String(r.stamped_ref),
  revision: Number(r.revision),
  repeatCount: Number(r.repeat_count),
  pinned: Boolean(r.pinned),
  reviewAfter: iso(r.review_after),
  expiresAt: iso(r.expires_at),
  state: r.state as Entry['state'],
  supersededBy: r.superseded_by == null ? null : String(r.superseded_by),
  compiled: Boolean(r.compiled),
  createdAt: iso(r.created_at) as string,
  updatedAt: iso(r.updated_at) as string,
})

// Closing a session with its summary: a `summary` entry in that session, then the session is closed
// and points at it (spec B1 «Sesiones», CA8).
export async function summarizeSession(
  ctx: Ctx,
  sessionId: string,
  input: { title?: string; content: string; requestKey?: string },
): Promise<Receipt> {
  const p = prepare({
    type: 'summary',
    title: input.title?.trim() || 'Session summary',
    content: input.content,
  })
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const s = await db.one('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [sessionId])
    if (!s || !(await ownsSession(db, ctx.who, s))) throw notFound('session')
    const { brain, role } = await inBrain(c, { id: String(s.brain_id) }, 'share').catch(() => {
      throw notFound('session')
    })
    await allow(c, 'journal.write', { role, brainStatus: brain.status }, brain.id)
    if (s.status !== 'open') {
      // A retry of the summary that closed it gets the same receipt back (CA5).
      if (input.requestKey !== undefined) {
        const seen = await db.one<{ receipt: Receipt }>(
          'SELECT receipt FROM request_keys WHERE credential_id = $1 AND key = $2',
          [ctx.who.credential.id, sha(input.requestKey)],
        )
        if (seen && seen.receipt.entryId === s.summary_entry_id) return canonical(seen.receipt)
      }
      throw conflict('session_closed', 'That session is already closed.', 'Open a new session for new work.')
    }
    const receipt = await write(ctx, db, brain.id, p, agentWriter(ctx), {
      sessionId,
      ...(input.requestKey !== undefined ? { requestKey: input.requestKey } : {}),
    })
    await db.query(
      "UPDATE sessions SET status = 'closed', summary_entry_id = $2, closed_at = $3 WHERE id = $1",
      [sessionId, receipt.entryId, ctx.clock()],
    )
    await emit(db, c, { brainId: brain.id, kind: 'session.closed', targetId: sessionId, label: p.title })
    return receipt
  })
}

export type Revision = {
  revision: number
  type: string
  title: string
  content: string
  appliesTo: string | null
  tags: string[]
  refs: string[]
  authorId: string
  authorName: string
  createdAt: string
}

type Named = { id: string; name: string }
// Who wrote an entry and with what (the client named when it was written), for a person to read
// («Claude Code of Eric»); and, for a forgotten
// one (curators only see it), who forgot it, when and why.
export type Byline = {
  author: Named
  onBehalf: Named | null
  client: string | null
  forgotten: { by: Named; reason: string; at: string } | null
}

export async function bylines(db: Db, ids: string[]): Promise<Map<string, Byline>> {
  const out = new Map<string, Byline>()
  if (ids.length === 0) return out
  const rows = await db.query(
    `SELECT e.id, e.state, e.forgotten_reason, e.forgotten_at, a.id AS a_id, a.name AS a_name,
            o.id AS o_id, o.name AS o_name, f.id AS f_id, f.name AS f_name, e.client
       FROM entries e JOIN accounts a ON a.id = e.author_id
       LEFT JOIN accounts o ON o.id = e.on_behalf_id
       LEFT JOIN accounts f ON f.id = e.forgotten_by
      WHERE e.id = ANY($1)`,
    [ids],
  )
  for (const r of rows) {
    out.set(String(r.id), {
      author: { id: String(r.a_id), name: String(r.a_name) },
      onBehalf: r.o_id == null ? null : { id: String(r.o_id), name: String(r.o_name) },
      client: r.client == null ? null : String(r.client),
      forgotten:
        r.state === 'forgotten' && r.f_id != null
          ? {
              by: { id: String(r.f_id), name: String(r.f_name) },
              reason: String(r.forgotten_reason ?? ''),
              at: (r.forgotten_at as Date).toISOString(),
            }
          : null,
    })
  }
  return out
}

export const withByline = (e: Entry, b: Byline | undefined): Entry & Byline => ({
  ...e,
  author: b?.author ?? { id: e.authorId, name: '' },
  onBehalf: b?.onBehalf ?? null,
  client: b?.client ?? null,
  forgotten: b?.forgotten ?? null,
})

// The session an entry is in, named for a person (its purpose; the session a key gets by writing without
// opening one has its day instead), with its client and author: the web names a session the same
// everywhere («Web edits · Eric», «Unnamed work · Codex»).
export type SessionRef = {
  id: string
  purpose: string
  day: string | null
  client: string | null
  author: { id: string; name: string }
}

export async function sessionRefs(db: Db, ids: string[]): Promise<Map<string, SessionRef>> {
  const out = new Map<string, SessionRef>()
  if (ids.length === 0) return out
  const rows = await db.query(
    `SELECT s.id, s.purpose, s.day, s.client, s.account_id, a.name AS author_name
       FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.id = ANY($1)`,
    [[...new Set(ids)]],
  )
  for (const r of rows) {
    out.set(String(r.id), {
      id: String(r.id),
      purpose: String(r.purpose),
      day: dayText(r.day),
      client: r.client == null ? null : String(r.client),
      author: { id: String(r.account_id), name: String(r.author_name) },
    })
  }
  return out
}

// The relations of an entry, both ways, with the other entry's title — unless that one is purged, or
// forgotten and the reader is not a curator (forgotten entries leave the ordinary journal, spec B1). Then
// the reason goes too: it was written about the other entry and can repeat what it said.
export type EntryRelation = {
  id: string
  kind: string
  status: string
  direction: 'out' | 'in'
  other: { id: string; title: string | null; type: string; state: string }
  reason: string | null
  by: Named
  createdAt: string
}

async function relationsOf(db: Db, id: string, curator: boolean): Promise<EntryRelation[]> {
  const rows = await db.query(
    `SELECT r.*, ac.name AS by_name, o.id AS o_id, o.title AS o_title, o.type AS o_type, o.state AS o_state
       FROM relations r JOIN accounts ac ON ac.id = r.created_by
       JOIN entries o ON o.id = CASE WHEN r.from_id = $1 THEN r.to_id ELSE r.from_id END
      WHERE r.from_id = $1 OR r.to_id = $1 ORDER BY r.created_at, r.id LIMIT 200`,
    [id],
  )
  return rows.map((r) => {
    const hidden = r.o_state === 'purged' || (r.o_state === 'forgotten' && !curator)
    return {
      id: String(r.id),
      kind: String(r.kind),
      status: String(r.status),
      direction: r.from_id === id ? 'out' : 'in',
      other: {
        id: String(r.o_id),
        title: hidden ? null : String(r.o_title),
        type: String(r.o_type),
        state: String(r.o_state),
      },
      reason: hidden ? null : String(r.reason),
      by: { id: String(r.created_by), name: String(r.by_name) },
      createdAt: (r.created_at as Date).toISOString(),
    }
  })
}

// Reading one entry. A forgotten entry is visible only to curators; a purged one only shows the mark
// of the purge (spec B1 «Corregir, olvidar y purgar»).
export async function getEntry(
  ctx: Ctx,
  id: string,
  o: { history?: boolean } = {},
): Promise<{ entry: Entry & Byline; session: SessionRef; relations: EntryRelation[]; history?: Revision[] }> {
  const row = await ctx.db.one('SELECT * FROM entries WHERE id = $1', [id])
  if (!row) throw notFound('entry')
  const { role } = await inBrain(ctx, { id: String(row.brain_id) }).catch(() => {
    throw notFound('entry')
  })
  if (row.state === 'forgotten' && role !== 'curator') throw notFound('entry')
  const entry = withByline(entryOf(row), (await bylines(ctx.db, [id])).get(id))
  const relations = row.state === 'purged' ? [] : await relationsOf(ctx.db, id, role === 'curator')
  const session = (await sessionRefs(ctx.db, [entry.sessionId])).get(entry.sessionId) as SessionRef
  // A purged entry's mark is shown, but its id never goes back into the trail (CA13).
  if (row.state !== 'purged') {
    await track(ctx.root ?? ctx.db, ctx, {
      brainId: entry.brainId,
      kind: 'read',
      resultIds: [entry.id],
      label: entry.title,
    })
  }
  if (!o.history || row.state === 'purged') return { entry, session, relations }
  const revs = await ctx.db.query(
    `SELECT r.*, a.name AS author_name FROM entry_revisions r JOIN accounts a ON a.id = r.author_id
      WHERE r.entry_id = $1 ORDER BY r.revision`,
    [id],
  )
  return {
    entry,
    session,
    relations,
    history: revs.map((r) => ({
      revision: Number(r.revision),
      type: String(r.type),
      title: String(r.title),
      content: String(r.content),
      appliesTo: r.applies_to == null ? null : String(r.applies_to),
      tags: (r.tags as string[]) ?? [],
      refs: (r.refs as string[]) ?? [],
      authorId: String(r.author_id),
      authorName: String(r.author_name),
      createdAt: (r.created_at as Date).toISOString(),
    })),
  }
}
