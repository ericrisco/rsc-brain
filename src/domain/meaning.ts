// Search by meaning (spec B3 «Búsqueda por significado»): optional and off by default. The administration
// turns it on in the web, choosing a provider and accepting that text is sent to it. A curator can
// exclude a brain: its vectors go and nothing more of it is sent. While existing text is processed,
// what is not processed yet is still found by words; a provider that fails never fails a search.
import { seal } from '../auth/vault.ts'
import { AppError, invalid, notFound } from '../core/errors.ts'
import type { Db, Row } from '../db/db.ts'
import { type Providers, SEND_CHARS } from '../meaning/providers.ts'
import { applyStored, destinationOf, environmentOf, keyOpens, stored } from '../meaning/stored.ts'
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

// The providers this installation knows, and where each one's key or address comes from: set in the web
// ("settings"), the server's environment, or nowhere yet. A key is named by its last 4 characters only.
export const PROVIDERS = [
  { name: 'openai', label: 'OpenAI', needs: 'key' },
  { name: 'ollama', label: 'Ollama', needs: 'url' },
] as const
type ProviderName = (typeof PROVIDERS)[number]['name']

// The address of a provider from the server's environment is shown as scheme, host and port only: its path,
// query or credentials may hold what the environment keeps to itself.
function originOf(url: string | null | undefined): { url: string | null; hidden: boolean } {
  if (!url) return { url: null, hidden: false }
  try {
    const u = new URL(url)
    const origin = `${u.protocol}//${u.host}`
    return { url: origin, hidden: url.replace(/\/+$/, '') !== origin }
  } catch {
    return { url: null, hidden: true }
  }
}

async function providerViews(ctx: Ctx) {
  const st = await stored(ctx.db)
  const env = environmentOf(ctx.meaning ?? {})
  return PROVIDERS.map((p) => {
    const set = p.name === 'openai' ? st.openaiKey !== null : st.ollamaUrl !== null
    const source = set ? 'settings' : env[p.name] ? 'environment' : null
    const live = ctx.meaning?.[p.name]
    const fromEnv = p.needs === 'url' && !set ? originOf(env[p.name]?.url) : null
    return {
      name: p.name,
      label: p.label,
      needs: p.needs,
      source,
      last4: p.needs === 'key' ? (set ? st.openaiLast4 : (env[p.name]?.last4 ?? null)) : null,
      url: p.needs === 'url' ? (set ? st.ollamaUrl : (fromEnv?.url ?? null)) : null,
      urlHidden: fromEnv?.hidden ?? false,
      // Set here but sealed with another installation secret: it cannot be used; the environment's, if any, is.
      unreadable: p.name === 'openai' && set && !keyOpens(ctx.mail?.secret, st.openaiKey),
      model: live?.model ?? null,
    }
  })
}

// A new destination for the provider in use (another key, another address, or the environment's in place of
// the web's) sends text where the warning did not say: meaning search goes off, and the acceptance with it.
async function offForNewDestination(db: Db, ctx: Ctx, p: string, now: Date): Promise<void> {
  const s = await meaningSettings(db)
  if (!s.enabled || s.provider !== p) return
  await db.query(
    `UPDATE meaning_settings SET enabled = false, accepted_by = NULL, accepted_at = NULL, changed_at = $1,
            off_reason = $2 WHERE id = 1`,
    [
      now,
      `Turned off: the key or address of ${p} changed in the administration. Accept the warning again to turn it on.`,
    ],
  )
  await audit(db, {
    at: now,
    actorId: ctx.who.accountId,
    credentialId: ctx.who.credential.id,
    action: 'meaning.disable',
    outcome: 'ok',
    detail: `${p}: its key or address changed; the warning must be accepted again`,
  })
}

async function offReason(db: Db): Promise<string | null> {
  const r = await db.one<{ off_reason: string | null }>(
    'SELECT off_reason FROM meaning_settings WHERE id = 1',
  )
  return r?.off_reason ?? null
}

export async function getMeaning(ctx: Ctx) {
  adminInWeb(ctx)
  const s = await meaningSettings(ctx.db)
  return {
    ...s,
    available: Object.keys(ctx.meaning ?? {}),
    providers: await providerViews(ctx),
    // Why it went off by itself (a new destination), until it is turned on again.
    offReason: s.enabled ? null : await offReason(ctx.db),
    warning: WARNING,
    progress: s.enabled ? await meaningProgress(ctx.db, s) : null,
  }
}

function providerOf(name: string): ProviderName {
  const p = PROVIDERS.find((x) => x.name === name)
  if (!p) throw notFound('meaning provider')
  return p.name
}

// The key of a paid provider, or the address of a local one, set from the web. The key is sealed with the
// installation secret and never given back; the audit says it was set, never what it is.
export async function setProvider(ctx: Ctx, name: string, input: { key?: unknown; url?: unknown }) {
  adminInWeb(ctx)
  const p = providerOf(name)
  const now = ctx.clock()
  if (p === 'openai') {
    const key = input.key
    if (typeof key !== 'string' || key.length < 20 || key.length > 300 || /\s/.test(key)) {
      throw invalid(
        '"key" is the API key of the provider, as it gave it.',
        'Paste the whole key, without spaces.',
      )
    }
    const sealed = seal(ctx.mail?.secret, key, 'meaning.openai')
    await ctx.db.tx(async (db) => {
      await db.query('SELECT 1 FROM meaning_settings WHERE id = 1 FOR UPDATE')
      await offForNewDestination(db, ctx, p, now)
      await db.query('UPDATE meaning_settings SET openai_key = $1, openai_key_last4 = $2 WHERE id = 1', [
        sealed,
        key.slice(-4),
      ])
      await audit(db, {
        at: now,
        actorId: ctx.who.accountId,
        credentialId: ctx.who.credential.id,
        action: 'meaning.provider',
        outcome: 'ok',
        detail: `${p}: key set`,
      })
    })
  } else {
    const url = typeof input.url === 'string' ? input.url.trim().replace(/\/+$/, '') : ''
    let u: URL | null = null
    try {
      u = new URL(url)
    } catch {
      u = null
    }
    if (
      !u ||
      (u.protocol !== 'http:' && u.protocol !== 'https:') ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      url.length > 300
    ) {
      throw invalid(
        '"url" is the address of the provider, such as http://localhost:11434.',
        'Give a plain http or https address.',
      )
    }
    await ctx.db.tx(async (db) => {
      await db.query('SELECT 1 FROM meaning_settings WHERE id = 1 FOR UPDATE')
      const was = (await stored(db)).ollamaUrl
      if (was !== url) await offForNewDestination(db, ctx, p, now)
      await db.query('UPDATE meaning_settings SET ollama_url = $1 WHERE id = 1', [url])
      await audit(db, {
        at: now,
        actorId: ctx.who.accountId,
        credentialId: ctx.who.credential.id,
        action: 'meaning.provider',
        outcome: 'ok',
        detail: `${p}: address set to ${url}`,
      })
    })
  }
  if (ctx.meaning) await applyStored(ctx.db, ctx.meaning, ctx.mail?.secret)
  return getMeaning(ctx)
}

// Removing what was set from the web brings back what the environment has, if anything. The provider in use
// cannot lose its key while meaning search is on: turning it off comes first, so it is never on and silent.
export async function removeProvider(ctx: Ctx, name: string) {
  adminInWeb(ctx)
  const p = providerOf(name)
  const now = ctx.clock()
  await ctx.db.tx(async (db) => {
    await db.query('SELECT 1 FROM meaning_settings WHERE id = 1 FOR UPDATE')
    const s = await meaningSettings(db)
    if (s.enabled && s.provider === p && !environmentOf(ctx.meaning ?? {})[p]) {
      throw new AppError(
        409,
        'provider_in_use',
        `Meaning search is on with ${p}: without its ${p === 'openai' ? 'key' : 'address'} it would stop.`,
        'Turn meaning search off first, or set a new one in its place.',
      )
    }
    // The environment's provider takes its place: another destination.
    await offForNewDestination(db, ctx, p, now)
    await db.query(
      p === 'openai'
        ? 'UPDATE meaning_settings SET openai_key = NULL, openai_key_last4 = NULL WHERE id = 1'
        : 'UPDATE meaning_settings SET ollama_url = NULL WHERE id = 1',
    )
    await audit(db, {
      at: now,
      actorId: ctx.who.accountId,
      credentialId: ctx.who.credential.id,
      action: 'meaning.provider',
      outcome: 'ok',
      detail: `${p}: removed`,
    })
  })
  if (ctx.meaning) await applyStored(ctx.db, ctx.meaning, ctx.mail?.secret)
  return getMeaning(ctx)
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
        : 'Set a key or address in Admin › Meaning search (or RSC_BRAIN_OPENAI_KEY or RSC_BRAIN_OLLAMA_URL for the server), then try again.',
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
              accepted_at = $4, changed_at = $4, destination = $5, off_reason = NULL WHERE id = 1`,
      // Where the text goes, as accepted: checked again whenever the providers change or the server starts.
      [p.name, p.model, ctx.who.accountId, now, destinationOf(p, ctx.mail?.secret)],
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
    await db.query(
      'UPDATE meaning_settings SET enabled = false, changed_at = $1, off_reason = NULL WHERE id = 1',
      [now],
    )
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
    await tx.query('DELETE FROM meaning_failures WHERE kind = $1 AND target_id = $2', [r.kind, r.id])
  })
}

// Processes up to one batch of what has no current vector. Whether a brain is excluded is checked right
// before sending and again, under the brain's lock, when storing (CA8). A batch that fails counts one
// attempt for each of its texts and is tried again later: what failed before goes last, and alone, so
// a text the provider always refuses never blocks the rest.
export async function embedPending(db: Db, providers: Providers, now: Date, batch = BATCH): Promise<number> {
  const s = await meaningSettings(db)
  const p = s.enabled && s.provider ? providers[s.provider] : undefined
  if (!p || p.model !== s.model) return 0
  let rows = await db.query<Row>(
    `SELECT x.kind, x.id, x.brain_id, x.text, md5(x.text) AS hash, coalesce(f.attempts, 0) AS attempts
       FROM (${EMBEDDABLE}) x
       LEFT JOIN meaning_failures f ON f.kind = x.kind AND f.target_id = x.id
      WHERE ${NOT_EXCLUDED}
        AND NOT EXISTS (SELECT 1 FROM meaning_vectors v WHERE v.kind = x.kind AND v.target_id = x.id
                          AND v.provider = $1 AND v.model = $2 AND v.text_hash = md5(x.text))
      ORDER BY coalesce(f.attempts, 0), x.kind, x.id LIMIT $3`,
    [p.name, p.model, batch],
  )
  if (rows.length === 0) return 0
  // After an outage everything pending failed once, and goes in full batches again. What failed twice
  // goes alone, so the text the provider refuses is found and the rest moves on.
  if (Number(rows[0]?.attempts) > 1) rows = rows.slice(0, 1)
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
  let vecs: number[][]
  try {
    vecs = await p.embed(
      send.map((r) => String(r.text).slice(0, SEND_CHARS)),
      { signal: AbortSignal.timeout(30_000) },
    )
  } catch (err) {
    for (const r of send) {
      await db.query(
        `INSERT INTO meaning_failures (kind, target_id, brain_id, attempts, at)
         SELECT $1, $2, $3, 1, $4
          WHERE EXISTS (SELECT 1 FROM (${EMBEDDABLE}) x WHERE x.kind = $1 AND x.id = $2)
         ON CONFLICT (kind, target_id) DO UPDATE SET attempts = meaning_failures.attempts + 1, at = $4`,
        [r.kind, r.id, r.brain_id, now],
      )
    }
    throw err
  }
  for (const [i, r] of send.entries()) {
    const v = vecs[i]
    if (v) await store(db, r, v, p, now)
  }
  return send.length
}

// One run of the server's worker: batches while there is work, at most `max` of them. A failure ends the
// run; the next run tries again.
export async function embedRound(db: Db, providers: Providers, clock: () => Date, max = 20): Promise<number> {
  let n = 0
  for (let i = 0; i < max; i++) {
    let k: number
    try {
      k = await embedPending(db, providers, clock())
    } catch {
      break
    }
    if (k === 0) break
    n += k
  }
  return n
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
