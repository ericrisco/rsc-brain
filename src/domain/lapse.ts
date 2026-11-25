// Spec learning-memory B2 (plan §2.7): how long each type of entry lasts without use, and whether an entry is still in
// force. Computed when read, so a curator's change of a lifetime holds for the entries already saved too (CA-B10).
//   - A date set by hand (expires_at) wins over everything (CA-B9).
//   - Else: a type that never lapses, a pinned entry, or one cited as a source by a current or stale page stays (B14).
//   - Else it lapses `days of its type` after lapse_from: when it was written, its topic last revised, or, for what
//     existed before tranche 1, the day of the upgrade (CA-U1).
// Tranche 2 moves lapse_from when an entry is used («using renews»); tranche 3 adds candidates to the exemptions.
import { AppError } from '../core/errors.ts'
import type { Db } from '../db/db.ts'
import { ENTRY_TYPES, type EntryType } from './entries.ts'

// The defaults of the spec, in days; null: never.
export const DEFAULT_LIFETIMES: Readonly<Record<EntryType, number | null>> = {
  decision: null,
  learning: 60,
  attempt: 14,
  correction: null,
  preference: null,
  fact: null,
  step: 7,
  summary: 30,
  note: 30,
}
export const LIFETIME_MIN = 1
export const LIFETIME_MAX = 3650

export type Lifetimes = Record<EntryType, number | null>

// The lifetimes in force for a brain: its own value where it has one, the default elsewhere.
export function lifetimesOf(overrides: unknown): Lifetimes {
  const own = overrides && typeof overrides === 'object' ? (overrides as Record<string, unknown>) : {}
  const out = {} as Lifetimes
  for (const t of ENTRY_TYPES) {
    const v = own[t]
    out[t] = t in own ? (typeof v === 'number' ? v : null) : DEFAULT_LIFETIMES[t]
  }
  return out
}

const invalid = (message: string) =>
  new AppError(
    400,
    'invalid_request',
    message,
    `Send "entryLifetimes" as {"<type>": days or null}, with a type among ${ENTRY_TYPES.join(', ')} and days from ${LIFETIME_MIN} to ${LIFETIME_MAX} (null: never).`,
  )

// What a curator sends: some types, each days (1–3650) or null for never.
export function readLifetimes(v: unknown): Partial<Lifetimes> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid('"entryLifetimes" is an object.')
  const out: Partial<Lifetimes> = {}
  for (const [k, d] of Object.entries(v as Record<string, unknown>)) {
    if (!(ENTRY_TYPES as readonly string[]).includes(k))
      throw invalid(`"${k.slice(0, 40)}" is not a type of entry.`)
    if (
      d !== null &&
      (typeof d !== 'number' || !Number.isSafeInteger(d) || d < LIFETIME_MIN || d > LIFETIME_MAX)
    )
      throw invalid(
        `The lifetime of "${k}" goes from ${LIFETIME_MIN} to ${LIFETIME_MAX} days, or null for never.`,
      )
    out[k as EntryType] = d as number | null
  }
  return out
}

// The days of an entry's type in its brain (SQL; null: never).
const daysOf = (e: string) =>
  `public.brain_entry_days(${e}.type, (SELECT ws.entry_lifetimes FROM wiki_settings ws WHERE ws.brain_id = ${e}.brain_id))`

// The lifetimes in force for each of these brains (brains without settings have the defaults).
export async function lifetimesByBrain(db: Db, brainIds: string[]): Promise<Map<string, Lifetimes>> {
  const rows = await db.query(
    'SELECT brain_id, entry_lifetimes FROM wiki_settings WHERE brain_id = ANY($1)',
    [brainIds],
  )
  const own = new Map(rows.map((r) => [String(r.brain_id), r.entry_lifetimes]))
  return new Map(brainIds.map((id) => [id, lifetimesOf(own.get(id))]))
}

// When an entry lapses (SQL; null: it does not).
export const lapsesAt = (e: string) =>
  `(CASE WHEN ${e}.expires_at IS NOT NULL THEN ${e}.expires_at
         WHEN ${e}.pinned THEN NULL
         WHEN ${daysOf(e)} IS NULL THEN NULL
         WHEN EXISTS (SELECT 1 FROM page_sources ls JOIN pages lp ON lp.id = ls.page_id
                       WHERE ls.entry_id = ${e}.id AND lp.status IN ('current', 'stale')) THEN NULL
         ELSE ${e}.lapse_from + make_interval(days => ${daysOf(e)}) END)`

// Whether an entry has not lapsed at `now` (a SQL parameter or expression). The same rules as lapsesAt, written so the
// cheap tests come first and the look for a citing page runs only for an entry its lifetime has already left behind:
// a CASE is evaluated in order (search filters thousands of candidates with it; plan §7.2 R3).
export const notLapsed = (e: string, now: string) =>
  `(CASE WHEN ${e}.expires_at IS NOT NULL THEN ${e}.expires_at > ${now}
         WHEN ${e}.pinned THEN true
         WHEN coalesce(${e}.lapse_from + make_interval(days => ${daysOf(e)}) > ${now}, true) THEN true
         ELSE EXISTS (SELECT 1 FROM page_sources ls JOIN pages lp ON lp.id = ls.page_id
                       WHERE ls.entry_id = ${e}.id AND lp.status IN ('current', 'stale')) END)`

// An entry in force: active, not superseded, not lapsed (what search, the start context and corrections read).
export const vigentEntry = (e: string, now: string) =>
  `(${e}.state = 'active' AND ${e}.superseded_by IS NULL AND ${notLapsed(e, now)})`

// notLapsed for a search over many entries of known brains: the lifetimes are read once and each type's limit becomes
// a constant, so a row costs a comparison of dates, not a function and a look into the settings (plan §7.2 R3: search
// filters up to every entry of a brain with it). `param` adds a value to the query and gives its placeholder.
// The pages that keep their sources come from one look over the brains searched, hashed once by PostgreSQL, not one
// look per entry. `brains`: SQL that holds the brain ids searched (an array).
export function notLapsedIn(
  e: string,
  now: Date,
  byBrain: Map<string, Lifetimes>,
  param: (v: unknown) => string,
  brains: string = param([...byBrain.keys()]),
): string {
  const groups = new Map<string, { ids: string[]; l: Lifetimes }>()
  for (const [id, l] of byBrain) {
    const k = JSON.stringify(l)
    const g = groups.get(k) ?? { ids: [], l }
    g.ids.push(id)
    groups.set(k, g)
  }
  const fresh = (l: Lifetimes) => {
    const arms = ENTRY_TYPES.filter((t) => l[t] !== null).map(
      (t) =>
        `WHEN '${t}' THEN ${e}.lapse_from > ${param(new Date(now.getTime() - (l[t] as number) * 86_400_000))}::timestamptz`,
    )
    return arms.length ? `(CASE ${e}.type ${arms.join(' ')} ELSE true END)` : 'true'
  }
  const all = [...groups.values()]
  const byType =
    all.length === 0
      ? 'true'
      : all.length === 1
        ? fresh((all[0] as { l: Lifetimes }).l)
        : `(CASE ${all.map((g) => `WHEN ${e}.brain_id = ANY(${param(g.ids)}::text[]) THEN ${fresh(g.l)}`).join(' ')} ELSE true END)`
  return `(CASE WHEN ${e}.expires_at IS NOT NULL THEN ${e}.expires_at > ${param(now)}::timestamptz
         WHEN ${e}.pinned THEN true
         WHEN ${byType} THEN true
         ELSE ${e}.id IN (SELECT ls.entry_id FROM page_sources ls JOIN pages lp ON lp.id = ls.page_id
                           WHERE lp.brain_id = ANY(${brains}::text[]) AND lp.status IN ('current', 'stale')
                             AND ls.entry_id IS NOT NULL) END)`
}

// A value written into the SQL itself, for queries whose parameters are fixed: only dates and ids this code made.
export function sqlLiteral(v: unknown): string {
  if (v instanceof Date) return `'${v.toISOString()}'`
  if (Array.isArray(v) && v.every((x) => typeof x === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(x)))
    return `ARRAY[${v.map((x) => `'${x}'`).join(',')}]::text[]`
  throw new Error('sqlLiteral takes a date or a list of ids')
}
