// Search by meaning (spec B3 «Búsqueda por significado»): optional and off by default. The administration
// turns it on in the web, choosing a provider and accepting that text is sent to it. A curator can
// exclude a brain: its vectors go and nothing more of it is sent. While existing text is processed,
// what is not processed yet is still found by words; a provider that fails never fails a search.
import { AppError, invalid } from '../core/errors.ts'
import type { Db, Row } from '../db/db.ts'
import { type Providers, SEND_CHARS } from '../meaning/providers.ts'
import { audit } from './audit.ts'
import type { Ctx } from './context.ts'
import { webOnly } from './wiki/review.ts'

export const WARNING =
  'The text of entries and pages will be sent to this provider to compute its meaning. What is sent cannot be taken back.'

// Below this similarity, a result is not "about the same thing".
export const MIN_SIMILARITY = 0.3
// How long a search waits for the provider before it goes on by words only.
export const QUERY_TIMEOUT_MS = 3000
export const BATCH = 32

export type MeaningSettings = {
  enabled: boolean
  provider: string | null
  model: string | null
  acceptedBy: string | null
  acceptedAt: string | null
}

export async function meaningSettings(db: Db): Promise<MeaningSettings> {
  const r = await db.one<Row>('SELECT * FROM meaning_settings WHERE id = 1')
  return {
    enabled: Boolean(r?.enabled),
    provider: r?.provider == null ? null : String(r.provider),
    model: r?.model == null ? null : String(r.model),
    acceptedBy: r?.accepted_by == null ? null : String(r.accepted_by),
    acceptedAt: r?.accepted_at == null ? null : (r.accepted_at as Date).toISOString(),
  }
}

function adminInWeb(ctx: Ctx): void {
  webOnly(ctx)
  if (!ctx.who.isAdmin) {
    throw new AppError(
      403,
      'forbidden',
      'Only the administration turns meaning search on or off.',
      'Ask the administration of this installation.',
    )
  }
}

// What can be sent: active entries and pages not retired, of brains not excluded.
const EMBEDDABLE = `
  SELECT 'entry' AS kind, e.id, e.brain_id, e.title || E'\\n' || e.content AS text
    FROM entries e WHERE e.state = 'active'
  UNION ALL
  SELECT 'page', p.id, p.brain_id, p.title || E'\\n' || p.summary || E'\\n' || p.body
    FROM pages p WHERE p.status <> 'retired'`

const NOT_EXCLUDED = `NOT EXISTS (SELECT 1 FROM wiki_settings ws WHERE ws.brain_id = x.brain_id AND ws.meaning_excluded)`

export async function meaningProgress(db: Db, s: MeaningSettings): Promise<{ done: number; total: number }> {
  const r = await db.one<{ total: number; done: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM meaning_vectors v
               WHERE v.kind = x.kind AND v.target_id = x.id AND v.provider = $1 AND v.model = $2
                 AND v.text_hash = md5(x.text)))::int AS done
       FROM (${EMBEDDABLE}) x WHERE ${NOT_EXCLUDED}`,
    [s.provider ?? '', s.model ?? ''],
  )
  return { done: r?.done ?? 0, total: r?.total ?? 0 }
}

export async function getMeaning(ctx: Ctx) {
  adminInWeb(ctx)
  const s = await meaningSettings(ctx.db)
  return {
    ...s,
    available: Object.keys(ctx.meaning ?? {}),
    warning: WARNING,
    progress: s.enabled ? await meaningProgress(ctx.db, s) : null,
  }
}

// Turning it on, or changing provider, needs the warning accepted in the same request (CA7). A new
// provider or model processes everything again: the vectors of the old one go.
export async function enableMeaning(ctx: Ctx, input: { provider: string; accept: boolean }) {
  adminInWeb(ctx)
  const p = ctx.meaning?.[input.provider]
  if (!p) {
    const names = Object.keys(ctx.meaning ?? {})
    throw invalid(
      `The provider "${input.provider}" is not configured in this installation.`,
      names.length
        ? `Use one of: ${names.join(', ')}.`
        : 'Set RSC_BRAIN_OPENAI_KEY or RSC_BRAIN_OLLAMA_URL for the server, then try again.',
    )
  }
  if (input.accept !== true) {
    const err = invalid(
      'Meaning search stays off until the warning is accepted.',
      'Read the warning and send "accept": true.',
    )
    err.current = { warning: WARNING }
    throw err
  }
  const now = ctx.clock()
  await ctx.db.tx(async (db) => {
    await db.query(
      `UPDATE meaning_settings SET enabled = true, provider = $1, model = $2, accepted_by = $3,
              accepted_at = $4, changed_at = $4 WHERE id = 1`,
      [p.name, p.model, ctx.who.accountId, now],
    )
    await db.query('DELETE FROM meaning_vectors WHERE provider <> $1 OR model <> $2', [p.name, p.model])
    await audit(db, {
      at: now,
      actorId: ctx.who.accountId,
      credentialId: ctx.who.credential.id,
      action: 'meaning.enable',
      brainId: null,
      outcome: 'ok',
      detail: `${p.name} (${p.model}); warning accepted`,
    })
  })
  return getMeaning(ctx)
}

export async function disableMeaning(ctx: Ctx) {
  adminInWeb(ctx)
  const now = ctx.clock()
  await ctx.db.tx(async (db) => {
    await db.query('UPDATE meaning_settings SET enabled = false, changed_at = $1 WHERE id = 1', [now])
    await audit(db, {
      at: now,
      actorId: ctx.who.accountId,
      credentialId: ctx.who.credential.id,
      action: 'meaning.disable',
      brainId: null,
      outcome: 'ok',
    })
  })
  return getMeaning(ctx)
}

// One lock per brain between storing vectors and what makes them wrong: excluding the brain, purging
// in it. Storing takes it shared; those take it exclusive, so a vector computed from text that is
// being purged, or for a brain being excluded, is never stored after the fact.
export async function lockMeaning(db: Db, brainId: string, shared = false): Promise<void> {
  await db.query(
    `SELECT ${shared ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock'}(hashtext($1))`,
    [`meaning:${brainId}`],
  )
}

const SKIPPED = `NOT EXISTS (SELECT 1 FROM meaning_failures f WHERE f.kind = x.kind AND f.target_id = x.id
                              AND f.provider = $1 AND f.model = $2 AND f.text_hash = md5(x.text))`

// Stores one vector if, under the brain's lock, its source still has the same text and may be sent.
async function store(db: Db, r: Row, vec: number[], p: { name: string; model: string }, now: Date) {
  await db.tx(async (tx) => {
    await lockMeaning(tx, String(r.brain_id), true)
    const still = await tx.one(
      `SELECT 1 FROM (${EMBEDDABLE}) x
        WHERE x.kind = $1 AND x.id = $2 AND md5(x.text) = $3
          AND NOT EXISTS (SELECT 1 FROM wiki_settings ws WHERE ws.brain_id = x.brain_id AND ws.meaning_excluded)`,
      [r.kind, r.id, r.hash],
    )
    if (!still) return
    await tx.query(
      `INSERT INTO meaning_vectors (kind, target_id, brain_id, provider, model, text_hash, vec, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (kind, target_id) DO UPDATE
         SET provider = EXCLUDED.provider, model = EXCLUDED.model, text_hash = EXCLUDED.text_hash,
             vec = EXCLUDED.vec, updated_at = EXCLUDED.updated_at`,
      [r.kind, r.id, r.brain_id, p.name, p.model, r.hash, vec, now],
    )
  })
}

// Processes up to one batch of what has no current vector. Whether a brain is excluded is checked right
// before sending and again, under the brain's lock, when storing (CA8). A text the provider refuses on
// its own is set aside, so it never blocks what comes after it.
export async function embedPending(db: Db, providers: Providers, now: Date, batch = BATCH): Promise<number> {
  const s = await meaningSettings(db)
  const p = s.enabled && s.provider ? providers[s.provider] : undefined
  if (!p || p.model !== s.model) return 0
  const rows = await db.query<Row>(
    `SELECT x.kind, x.id, x.brain_id, x.text, md5(x.text) AS hash FROM (${EMBEDDABLE}) x
      WHERE ${NOT_EXCLUDED} AND ${SKIPPED}
        AND NOT EXISTS (SELECT 1 FROM meaning_vectors v WHERE v.kind = x.kind AND v.target_id = x.id
                          AND v.provider = $1 AND v.model = $2 AND v.text_hash = md5(x.text))
      ORDER BY x.kind, x.id LIMIT $3`,
    [p.name, p.model, batch],
  )
  if (rows.length === 0) return 0
  const excluded = new Set(
    (
      await db.query<{ brain_id: string }>(
        'SELECT brain_id FROM wiki_settings WHERE meaning_excluded AND brain_id = ANY($1)',
        [rows.map((r) => r.brain_id)],
      )
    ).map((r) => r.brain_id),
  )
  const send = rows.filter((r) => !excluded.has(String(r.brain_id)))
  if (send.length === 0) return 0
  const texts = send.map((r) => String(r.text).slice(0, SEND_CHARS))
  let vecs: (number[] | null)[]
  try {
    vecs = await p.embed(texts, { signal: AbortSignal.timeout(30_000) })
  } catch (err) {
    if (send.length === 1) {
      const r = send[0] as Row
      await db.query(
        `INSERT INTO meaning_failures (kind, target_id, provider, model, text_hash, at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (kind, target_id) DO UPDATE SET provider = $3, model = $4, text_hash = $5, at = $6`,
        [r.kind, r.id, p.name, p.model, r.hash, now],
      )
      return 1
    }
    // The batch failed: try each text on its own to find the one the provider refuses. A provider that
    // is down fails them all, and the next run tries again.
    vecs = []
    let down = 0
    for (const t of texts) {
      try {
        const [v] = await p.embed([t], { signal: AbortSignal.timeout(30_000) })
        vecs.push(v ?? null)
      } catch {
        vecs.push(null)
        down++
      }
    }
    if (down === texts.length) throw err
    for (const [i, r] of send.entries()) {
      if (vecs[i] !== null) continue
      await db.query(
        `INSERT INTO meaning_failures (kind, target_id, provider, model, text_hash, at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (kind, target_id) DO UPDATE SET provider = $3, model = $4, text_hash = $5, at = $6`,
        [r.kind, r.id, p.name, p.model, r.hash, now],
      )
    }
  }
  for (const [i, r] of send.entries()) {
    const v = vecs[i]
    if (v) await store(db, r, v, p, now)
  }
  return send.length
}

export type MeaningMatches = {
  status: 'off' | 'on' | 'unavailable'
  entries: { ids: string[]; sims: number[] }
  pages: { ids: string[]; sims: number[] }
}

const none = (status: MeaningMatches['status']): MeaningMatches => ({
  status,
  entries: { ids: [], sims: [] },
  pages: { ids: [], sims: [] },
})

// How long the similarity scan may take before the search goes on by words only.
export const SCAN_TIMEOUT_MS = 2000
export const NEAR_LIMIT = 500

// The entries and pages closest in meaning to a search, in the given brains (not excluded ones), of the
// kinds asked for and alive. Nothing is sent when no brain asked takes part. Any failure or slowness of
// the provider or the scan answers "unavailable", never an error (CA5).
export async function meaningMatches(
  ctx: Ctx,
  brainIds: string[],
  text: string,
  kinds: ('entry' | 'page')[],
): Promise<MeaningMatches> {
  const s = await meaningSettings(ctx.db)
  if (!s.enabled || !s.provider || kinds.length === 0 || !text.trim()) return none('off')
  const taking = (
    await ctx.db.query<{ id: string }>(
      `SELECT b.id FROM brains b WHERE b.id = ANY($1)
          AND NOT EXISTS (SELECT 1 FROM wiki_settings ws WHERE ws.brain_id = b.id AND ws.meaning_excluded)`,
      [brainIds],
    )
  ).map((r) => r.id)
  if (taking.length === 0) return none('off')
  const p = ctx.meaning?.[s.provider]
  if (!p || p.model !== s.model) return none('unavailable')
  let q: number[]
  try {
    const [v] = await p.embed([text.slice(0, SEND_CHARS)], { signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) })
    if (!v) return none('unavailable')
    q = v
  } catch {
    return none('unavailable')
  }
  // A vector whose text changed since (an edit, a purge) is not used: it speaks of the old text.
  let rows: Row[]
  try {
    rows = await ctx.db.tx(async (tx) => {
      await tx.query(`SET LOCAL statement_timeout = ${SCAN_TIMEOUT_MS}`)
      return tx.query<Row>(
        `SELECT top.kind, top.target_id, top.sim FROM (
           SELECT v.kind, v.target_id, v.text_hash,
                  (SELECT sum(a * b) FROM unnest(v.vec, $4::real[]) AS t(a, b)) AS sim
             FROM meaning_vectors v
            WHERE v.brain_id = ANY($1) AND v.provider = $2 AND v.model = $3 AND cardinality(v.vec) = $5
              AND v.kind = ANY($6)
              AND CASE v.kind
                    WHEN 'entry' THEN EXISTS (SELECT 1 FROM entries e WHERE e.id = v.target_id AND e.state <> 'purged')
                    ELSE EXISTS (SELECT 1 FROM pages pg WHERE pg.id = v.target_id AND pg.status <> 'retired')
                  END
            ORDER BY sim DESC LIMIT ${NEAR_LIMIT}) top
          WHERE top.text_hash = CASE top.kind
            WHEN 'entry' THEN (SELECT md5(e.title || E'\\n' || e.content) FROM entries e WHERE e.id = top.target_id)
            ELSE (SELECT md5(p.title || E'\\n' || p.summary || E'\\n' || p.body) FROM pages p WHERE p.id = top.target_id)
          END
          ORDER BY top.sim DESC`,
        [taking, p.name, p.model, q, q.length, kinds],
      )
    })
  } catch {
    return none('unavailable')
  }
  const out = none('on')
  for (const r of rows) {
    const sim = Number(r.sim)
    if (!(sim >= MIN_SIMILARITY)) continue
    const bucket = r.kind === 'entry' ? out.entries : out.pages
    bucket.ids.push(String(r.target_id))
    bucket.sims.push(sim)
  }
  return out
}
