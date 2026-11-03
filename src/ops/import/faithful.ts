// A faithful export of another installation as a brain here (spec B7 «Importar», plan §3.6, CA13, C17): the rows
// of its NDJSON files go into the empty brain as they were, history included. What it trusts of the file: nothing.
//   - Only the columns the export writes are taken (none of an installation: no brain, no key); a file with any
//     other column, a row the schema refuses or a state an export never holds (purged) refuses the whole import.
//   - Every reference must name a row of the same export (or a person of its manifest): nothing it brings can point
//     at a page, an entry or a proposal of another brain here.
//   - The ids are kept; when this installation already has one of them (the same export imported twice), every id
//     is made new and every reference follows.
//   - People are found by email only when they are members of the brain imported into (a curator can then not give
//     someone else of the installation words they never wrote); everyone else is an author: a name, no account to
//     sign in with (migration 0023).
//   - What needs a key of this installation gets the importer's; sessions come in closed (their keys are gone).
//   - Every text is redacted again (pack rule 1), without eating the marks of the first redaction.
import { newId } from '../../core/ids.ts'
import { UnzipError } from '../../core/unzip.ts'
import type { Db } from '../../db/db.ts'
import type { Ctx } from '../../domain/context.ts'
import { isAddress } from '../../domain/wiki/model.ts'
import { FAITHFUL_FORMAT, FAITHFUL_VERSION } from '../export/faithful.ts'
import { addressOf, redactText } from './markdown.ts'
import type { FileTree, TreeFile } from './tree.ts'

const bad = (why: string) =>
  new UnzipError('invalid_archive', `This faithful export cannot be imported: ${why}.`)

type IdKind = 'session' | 'entry' | 'relation' | 'page' | 'proposal' | 'log'
const PREFIX: Record<IdKind, 'ses' | 'ent' | 'rel' | 'pg' | 'prp' | 'wlg'> = {
  session: 'ses',
  entry: 'ent',
  relation: 'rel',
  page: 'pg',
  proposal: 'prp',
  log: 'wlg',
}
const TABLE_OF: Record<IdKind, string> = {
  session: 'sessions',
  entry: 'entries',
  relation: 'relations',
  page: 'pages',
  proposal: 'proposals',
  log: 'wiki_log',
}

// Each file: its table, its own id, the columns it holds as the export writes them (people under their new names),
// which hold people, which hold ids of the export, and the columns this installation adds.
type Spec = {
  table: string
  id?: IdKind
  columns: string[]
  people: Record<string, string>
  refs: Record<string, IdKind>
  // Set after every row is in (they point within the same table).
  later?: string[]
}
const people = (...cols: string[]) => Object.fromEntries(cols.map((c) => [c.replace(/_id$/, ''), c]))
export const FILES: Record<string, Spec> = {
  sessions: {
    table: 'sessions',
    id: 'session',
    columns:
      'id account bound purpose ref day status summary_entry_id opened_at last_activity_at closed_at client'.split(
        ' ',
      ),
    people: people('account_id'),
    refs: { summary_entry_id: 'entry' },
    // The summary is an entry, and entries come after their sessions (review of PR32: the blocker).
    later: ['summary_entry_id'],
  },
  entries: {
    table: 'entries',
    id: 'entry',
    columns:
      `id session_id type topic title content applies_to tags refs author on_behalf stamped_ref revision
      repeat_count norm_hash pinned review_after expires_at state forgotten_by forgotten_reason forgotten_at superseded_by
      compiled created_at updated_at client`.split(/\s+/),
    people: people('author_id', 'on_behalf_id', 'forgotten_by'),
    refs: { session_id: 'session', superseded_by: 'entry' },
    later: ['superseded_by'],
  },
  entry_revisions: {
    table: 'entry_revisions',
    columns:
      'entry_id revision type title content applies_to tags refs author on_behalf stamped_ref created_at'.split(
        ' ',
      ),
    people: people('author_id', 'on_behalf_id'),
    refs: { entry_id: 'entry' },
  },
  relations: {
    table: 'relations',
    id: 'relation',
    columns: 'id from_id to_id kind status reason created_by created_at decided_at'.split(' '),
    people: people('created_by'),
    refs: { from_id: 'entry', to_id: 'entry' },
  },
  pages: {
    table: 'pages',
    id: 'page',
    columns:
      'id address type title summary body tags status superseded_by revision created_at updated_at'.split(
        ' ',
      ),
    people: {},
    refs: { superseded_by: 'page' },
    later: ['superseded_by'],
  },
  page_addresses: {
    table: 'page_addresses',
    columns: ['address', 'page_id', 'created_at'],
    people: {},
    refs: { page_id: 'page' },
  },
  proposals: {
    table: 'proposals',
    id: 'proposal',
    columns:
      `id title reason author agent status supersedes_id superseded_by collected comment decided_by decided_at
      last_error created_at purged_by purged_at purged_reason`.split(/\s+/),
    people: people('author_id', 'decided_by', 'purged_by'),
    refs: { supersedes_id: 'proposal', superseded_by: 'proposal' },
    later: ['supersedes_id', 'superseded_by'],
  },
  proposal_ops: {
    table: 'proposal_ops',
    columns: 'proposal_id idx op status corrected_by base_reviewed_by applied_page applied_revision'.split(
      ' ',
    ),
    people: people('corrected_by', 'base_reviewed_by'),
    refs: { proposal_id: 'proposal', applied_page: 'page' },
  },
  page_revisions: {
    table: 'page_revisions',
    columns:
      `page_id revision address type title summary body tags status sources links kind author proposal_id op_index
      corrected base_reviewed note created_at purged_by purged_at purged_reason reason`.split(/\s+/),
    people: people('author_id', 'purged_by'),
    refs: { page_id: 'page', proposal_id: 'proposal' },
  },
  page_links: {
    table: 'page_links',
    columns: ['from_page', 'kind', 'to_page', 'to_address'],
    people: {},
    refs: { from_page: 'page', to_page: 'page' },
  },
  page_sources: {
    table: 'page_sources',
    columns: ['page_id', 'entry_id', 'url', 'title'],
    people: {},
    refs: { page_id: 'page', entry_id: 'entry' },
  },
  wiki_settings: {
    table: 'wiki_settings',
    columns:
      'guide map_intro stale_days long_chars maintenance_every approvals_since usage_note meaning_excluded'.split(
        ' ',
      ),
    people: {},
    refs: {},
  },
  wiki_log: {
    table: 'wiki_log',
    id: 'log',
    columns: 'id at actor kind proposal_id summary pages reason'.split(' '),
    people: people('actor_id'),
    refs: { proposal_id: 'proposal' },
  },
}
// The order rows go in: every table after those it points to.
const ORDER = [
  'sessions',
  'entries',
  'entry_revisions',
  'relations',
  'pages',
  'page_addresses',
  'proposals',
  'proposal_ops',
  'page_revisions',
  'page_links',
  'page_sources',
  'wiki_settings',
  'wiki_log',
]
// Tables that need a key of this installation: the importer's.
const KEYED = new Set(['sessions', 'page_revisions', 'proposals'])
// The ids an export may hold: what this product makes ("ent_…"), and nothing that could be anything else.
const ID = /^[A-Za-z0-9_-]{1,80}$/

type Person = { ref: string; kind: string; name: string; email: string | null }
export type FaithfulPlan = { people: Person[]; rows: Record<string, Array<Record<string, unknown>>> }

// The files of a tree by path, made once per tree.
const byPath = new WeakMap<FileTree, Map<string, TreeFile>>()
const find = (tree: FileTree, name: string): TreeFile | undefined => {
  let m = byPath.get(tree)
  if (!m) {
    m = new Map(tree.files.map((f) => [f.path, f]))
    byPath.set(tree, m)
  }
  const direct = m.get(name)
  if (direct) return direct
  // A zip of the folder the export was unpacked to: one folder around everything.
  const top = tree.files[0]?.path.split('/')[0]
  return top ? m.get(`${top}/${name}`) : undefined
}

export async function isFaithful(tree: FileTree): Promise<boolean> {
  const m = find(tree, 'manifest.json')
  if (!m || m.size > 1024 * 1024) return false
  try {
    return (JSON.parse((await m.read()).toString('utf8')) as { format?: unknown }).format === FAITHFUL_FORMAT
  } catch {
    return false
  }
}

export async function planFaithful(tree: FileTree): Promise<FaithfulPlan> {
  const file = find(tree, 'manifest.json')
  if (!file) throw bad('it has no manifest.json')
  let m: Record<string, unknown>
  try {
    m = JSON.parse((await file.read()).toString('utf8')) as Record<string, unknown>
  } catch {
    throw bad('its manifest.json is not JSON')
  }
  if (m.version !== FAITHFUL_VERSION)
    throw bad(
      `it is version ${String(m.version)}; this release of rsc-brain reads version ${FAITHFUL_VERSION}`,
    )
  if (!Array.isArray(m.people)) throw bad('its manifest does not say who is who')
  const ppl: Person[] = []
  const refs = new Set<string>()
  for (const p of m.people as unknown[]) {
    const x = p as Record<string, unknown>
    if (
      !x ||
      typeof x.ref !== 'string' ||
      !/^p\d{1,9}$/.test(x.ref) ||
      refs.has(x.ref) ||
      typeof x.name !== 'string'
    )
      throw bad('its manifest names someone without a reference or a name')
    refs.add(x.ref)
    ppl.push({
      ref: x.ref,
      kind: String(x.kind),
      name: x.name,
      email: typeof x.email === 'string' ? x.email.trim().toLowerCase() : null,
    })
  }
  const rows: FaithfulPlan['rows'] = {}
  for (const name of ORDER) {
    const spec = FILES[name] as Spec
    const f = find(tree, `${name}.ndjson`)
    const list: Array<Record<string, unknown>> = []
    rows[name] = list
    if (!f) continue
    const buf = await f.read()
    let start = 0
    let line = 0
    while (start < buf.length) {
      let end = buf.indexOf(0x0a, start)
      if (end === -1) end = buf.length
      const text = buf.subarray(start, end).toString('utf8').trim()
      start = end + 1
      line += 1
      if (!text) continue
      let row: unknown
      try {
        row = JSON.parse(text)
      } catch {
        throw bad(`line ${line} of ${name}.ndjson is not JSON`)
      }
      if (!row || typeof row !== 'object' || Array.isArray(row))
        throw bad(`line ${line} of ${name}.ndjson is not a row`)
      for (const k of Object.keys(row))
        if (!spec.columns.includes(k))
          throw bad(`${name}.ndjson has a column "${k.slice(0, 40)}" an export never writes`)
      list.push(row as Record<string, unknown>)
    }
  }
  if ((rows.wiki_settings?.length ?? 0) > 1) throw bad('it holds the settings of more than one wiki')
  if (rows.entries?.some((e) => e.state !== 'active' && e.state !== 'forgotten'))
    throw bad('it holds an entry that was purged')
  return { people: ppl, rows }
}

// Every text redacted, every list and object walked.
function redactDeep(v: unknown): unknown {
  if (typeof v === 'string') return redactText(v)
  if (Array.isArray(v)) return v.map(redactDeep)
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]))
  return v
}

// What a refusal of the schema means here: the file holds a row that does not fit.
const fits = async <T>(table: string, f: () => Promise<T>): Promise<T> => {
  try {
    return await f()
  } catch (err) {
    const code = String((err as { code?: string }).code ?? '')
    if (/^(22|23)/.test(code)) throw bad(`a row of ${table} does not fit (${code})`)
    throw err
  }
}

// Every link (foreign key) between the tables an import fills, read from the database: each must point at a table
// filled before, or be in its table's `later` (set once every row is in). Asked at every import and by a test, so a
// link a later migration adds fails here and not halfway through someone's import (review of PR32). No DDL: an import
// runs while the installation serves, so its links are never made deferrable (that would lock every table).
export async function importOrderProblems(db: Db): Promise<string[]> {
  const tables = new Set(ORDER)
  const links = await db.query<{ t: string; col: string; ref: string }>(
    `SELECT conrelid::regclass::text AS t, a.attname::text AS col, confrelid::regclass::text AS ref
       FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`,
  )
  const out: string[] = []
  for (const l of links) {
    if (!tables.has(l.t) || !tables.has(l.ref)) continue
    const spec = FILES[l.t] as Spec
    if (ORDER.indexOf(l.ref) < ORDER.indexOf(l.t)) continue
    if (spec.later?.includes(l.col)) continue
    out.push(`${l.t}.${l.col} -> ${l.ref}`)
  }
  return out.sort()
}

// Addresses that are not addresses (a file made by hand, another release): made into one, each the same everywhere it
// is named, and said in the report.
function addressFixes(plan: FaithfulPlan): Map<string, string> {
  const named = new Set<string>()
  for (const r of plan.rows.pages ?? []) if (typeof r.address === 'string') named.add(r.address)
  for (const r of plan.rows.page_addresses ?? []) if (typeof r.address === 'string') named.add(r.address)
  const taken = new Set([...named].filter((a) => isAddress(a)))
  const fixes = new Map<string, string>()
  for (const a of [...named].sort()) {
    if (isAddress(a)) continue
    let to = addressOf(a)
    if (taken.has(to)) {
      let n = 2
      while (taken.has(`${to.slice(0, 195)}-${n}`)) n += 1
      to = `${to.slice(0, 195)}-${n}`
    }
    taken.add(to)
    fixes.set(a, to)
  }
  return fixes
}

// The same, inside the operations of a proposal and the links of a revision: every value of a key that names a page.
const ADDRESS_KEYS = new Set(['address', 'to', 'from', 'supersededBy'])
function fixAddresses(v: unknown, fixes: Map<string, string>, key = ''): unknown {
  if (typeof v === 'string') return ADDRESS_KEYS.has(key) ? (fixes.get(v) ?? v) : v
  if (Array.isArray(v)) return v.map((x) => fixAddresses(x, fixes, key))
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fixAddresses(x, fixes, k)]))
  return v
}

// What an imported author is called: their name, and that they were imported (a name alone could pass for someone
// of this installation; review of PR32).
export const IMPORTED = ' (imported)'
export const authorName = (name: string) => {
  const n = redactText(name.replace(/\s+/g, ' ').trim()) || 'Someone'
  return n.endsWith(IMPORTED) ? n.slice(0, 80) : `${n.slice(0, 80 - IMPORTED.length)}${IMPORTED}`
}

export async function writeFaithful(
  db: Db,
  ctx: Ctx,
  brainId: string,
  plan: FaithfulPlan,
  o: { from: string; now: Date },
): Promise<{
  pages: number
  entries: number
  links: number
  addresses: string[]
  people: { matched: number; authors: number }
  renamed: Array<{ path: string; address: string }>
}> {
  const wrong = await importOrderProblems(db)
  if (wrong.length) throw new Error(`The faithful import does not know how to fill ${wrong.join(', ')}.`)
  const fixes = addressFixes(plan)
  // People: a member of this brain with that email, or an author made now.
  const who = new Map<string, string>()
  let matched = 0
  let authors = 0
  for (const p of plan.people) {
    const found = p.email
      ? await db.one(
          `SELECT a.id FROM accounts a JOIN memberships m ON m.account_id = a.id AND m.brain_id = $2
            WHERE a.email = $1 AND a.kind = 'person' AND a.status = 'active'`,
          [p.email, brainId],
        )
      : null
    if (found) {
      who.set(p.ref, String(found.id))
      matched += 1
      continue
    }
    const id = newId('acc')
    const name = authorName(p.name)
    await db.query("INSERT INTO accounts (id, kind, name, created_at) VALUES ($1, 'author', $2, $3)", [
      id,
      name,
      o.now,
    ])
    who.set(p.ref, id)
    authors += 1
  }
  // The ids of the export, kept unless one is already here.
  const own: Record<IdKind, Set<string>> = {
    session: new Set(),
    entry: new Set(),
    relation: new Set(),
    page: new Set(),
    proposal: new Set(),
    log: new Set(),
  }
  for (const name of ORDER) {
    const spec = FILES[name] as Spec
    if (!spec.id) continue
    for (const r of plan.rows[name] ?? []) {
      const id = r.id
      if (typeof id !== 'string' || !ID.test(id)) throw bad(`a row of ${name} has no id`)
      if (own[spec.id].has(id)) throw bad(`${name} holds ${id} twice`)
      own[spec.id].add(id)
    }
  }
  let clash = false
  for (const k of Object.keys(own) as IdKind[]) {
    if (own[k].size === 0) continue
    const r = await db.one(`SELECT 1 FROM ${TABLE_OF[k]} WHERE id = ANY($1) LIMIT 1`, [[...own[k]]])
    if (r) clash = true
  }
  const map: Record<IdKind, Map<string, string>> = {
    session: new Map(),
    entry: new Map(),
    relation: new Map(),
    page: new Map(),
    proposal: new Map(),
    log: new Map(),
  }
  for (const k of Object.keys(own) as IdKind[])
    for (const id of own[k]) map[k].set(id, clash ? newId(PREFIX[k]) : id)
  const ref = (kind: IdKind, v: unknown, where: string): string | null => {
    if (v === null || v === undefined) return null
    const m = typeof v === 'string' ? map[kind].get(v) : undefined
    if (!m) throw bad(`${where} points at ${String(v).slice(0, 40)}, which is not in the export`)
    return m
  }
  // Ids inside JSON: a source {entryId}, the operations of a proposal.
  const inner = (v: unknown, where: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => inner(x, where))
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, k === 'entryId' ? ref('entry', x, where) : inner(x, where)]),
      )
    return v
  }
  const credential = ctx.who.credential.id
  const later: Array<{ table: string; key: Record<string, unknown>; sets: Record<string, unknown> }> = []
  for (const name of ORDER) {
    const spec = FILES[name] as Spec
    const out: Array<Record<string, unknown>> = []
    for (const raw of plan.rows[name] ?? []) {
      const r = redactDeep(raw) as Record<string, unknown>
      if (fixes.size) {
        if (typeof r.address === 'string') r.address = fixes.get(r.address) ?? r.address
        if (typeof r.to_address === 'string') r.to_address = fixes.get(r.to_address) ?? r.to_address
        if (Array.isArray(r.pages))
          r.pages = r.pages.map((a) => (typeof a === 'string' ? (fixes.get(a) ?? a) : a))
        if (r.links !== undefined) r.links = fixAddresses(r.links, fixes, 'links')
        if (r.op !== undefined) r.op = fixAddresses(r.op, fixes)
      }
      const row: Record<string, unknown> = {}
      for (const c of spec.columns) {
        if (!(c in r)) continue
        const v = r[c]
        if (spec.people[c]) {
          if (v === null || v === undefined) row[spec.people[c] as string] = null
          else {
            const id = typeof v === 'string' ? who.get(v) : undefined
            if (!id) throw bad(`${name} names someone (${String(v).slice(0, 20)}) its manifest does not`)
            row[spec.people[c] as string] = id
          }
        } else if (c === 'id' && spec.id) row.id = ref(spec.id, raw.id, name)
        else if (spec.refs[c]) row[c] = ref(spec.refs[c] as IdKind, raw[c], name)
        else if (c === 'collected') {
          if (!Array.isArray(v)) throw bad('a proposal has no list of entries it collected')
          row[c] = v.map((x) => ref('entry', x, name))
        } else if (c === 'sources' || c === 'op') row[c] = inner(v, name)
        else row[c] = v
      }
      if (
        name !== 'page_sources' &&
        name !== 'page_revisions' &&
        name !== 'entry_revisions' &&
        name !== 'proposal_ops'
      )
        row.brain_id = brainId
      if (KEYED.has(name)) row.credential_id = credential
      if (name === 'sessions' && row.status === 'open') {
        row.status = 'closed'
        row.closed_at = row.last_activity_at ?? o.now
      }
      for (const c of spec.later ?? []) {
        if (row[c] != null) later.push({ table: spec.table, key: { id: row.id }, sets: { [c]: row[c] } })
        row[c] = null
      }
      out.push(row)
    }
    if (name === 'wiki_settings' && out[0]) {
      const cols = spec.columns.filter((c) => c in (out[0] as object))
      await fits('wiki_settings', () =>
        db.query(
          `INSERT INTO wiki_settings (brain_id, ${cols.join(', ')})
           SELECT brain_id, ${cols.join(', ')} FROM jsonb_populate_record(NULL::wiki_settings, $1::jsonb)
           ON CONFLICT (brain_id) DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`,
          [JSON.stringify(out[0])],
        ),
      )
      continue
    }
    for (let i = 0; i < out.length; i += 500) {
      const batch = out.slice(i, i + 500)
      const cols = [...new Set(batch.flatMap((r) => Object.keys(r)))]
      await fits(spec.table, () =>
        db.query(
          `INSERT INTO ${spec.table} (${cols.join(', ')})
           SELECT ${cols.join(', ')} FROM jsonb_populate_recordset(NULL::${spec.table}, $1::jsonb)`,
          [JSON.stringify(batch)],
        ),
      )
    }
  }
  for (const l of later) {
    const [col, v] = Object.entries(l.sets)[0] as [string, unknown]
    await fits(l.table, () => db.query(`UPDATE ${l.table} SET ${col} = $2 WHERE id = $1`, [l.key.id, v]))
  }
  const count = async (sql: string) => Number((await db.one(sql, [brainId]))?.n ?? 0)
  const addresses = (
    await db.query('SELECT address FROM pages WHERE brain_id = $1 ORDER BY address', [brainId])
  ).map((r) => String(r.address))
  return {
    pages: addresses.length,
    entries: await count('SELECT count(*)::int AS n FROM entries WHERE brain_id = $1'),
    links: await count('SELECT count(*)::int AS n FROM page_links WHERE brain_id = $1'),
    addresses,
    people: { matched, authors },
    renamed: [...fixes].map(([path, address]) => ({ path, address })),
  }
}
