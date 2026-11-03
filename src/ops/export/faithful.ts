// The faithful export (spec B7 «Exportar», plan §3.5): everything of a brain that another installation needs to
// have it as it was, history included, for the import of PR32.
//   manifest.json   { format: 'rsc-brain-faithful', version: 1, release, exportedAt, includeForgotten, brain,
//                     counts, people[{ref, kind, name, email}] }
//   <kind>.ndjson   one JSON object a row, in key order: the original ids, the words as stored
// People are named by reference ("p1"…): a column that held an account id holds its reference (`author_id`
// becomes `author`; `…_by` keeps its name), and the manifest says who each one is: name, and email for current
// members of the brain. Left out: keys and
// anything about them (credential ids), hashes, sealed values, the trail and the activity, vectors. Purged
// entries never come, forgotten ones only when asked; what points at a left-out entry goes with it (its
// revisions, relations and place among a page's sources), or forgets it (a session's summary, a superseding
// entry, its id in the sources of an old revision or a proposal).

import type { Zip } from '../../core/zip.ts'
import type { Db } from '../../db/db.ts'
import type { ExportOptions } from './readable.ts'
import { rowsOf } from './rows.ts'

export const FAITHFUL_FORMAT = 'rsc-brain-faithful'
export const FAITHFUL_VERSION = 1

// The entries that come: active, and forgotten when asked ($2).
const KEPT = `SELECT id FROM entries WHERE brain_id = $1 AND (state = 'active' OR ($2 AND state = 'forgotten'))`
const kept = (column: string) => `(${column} IS NULL OR ${column} IN (${KEPT}))`
const keptOrNull = (column: string) => `CASE WHEN ${column} IN (${KEPT}) THEN ${column} END AS ${column}`

type Kind = { name: string; sql: string; people: string[] }

// Each kind with its columns in the order of the schema, filtered to the brain ($1).
export const KINDS: readonly Kind[] = [
  {
    name: 'sessions',
    sql: `SELECT id, account_id, bound, purpose, ref, day::text AS day, status, ${keptOrNull('summary_entry_id')},
                 opened_at, last_activity_at, closed_at, client
            FROM sessions WHERE brain_id = $1 ORDER BY id`,
    people: ['account_id'],
  },
  {
    name: 'entries',
    sql: `SELECT id, session_id, type, topic, title, content, applies_to, tags, refs, author_id, on_behalf_id,
                 stamped_ref, revision, repeat_count, norm_hash, pinned, review_after, expires_at, state,
                 forgotten_by, forgotten_reason, forgotten_at, ${keptOrNull('superseded_by')}, compiled, created_at,
                 updated_at, client
            FROM entries WHERE id IN (${KEPT}) ORDER BY id`,
    people: ['author_id', 'on_behalf_id', 'forgotten_by'],
  },
  {
    name: 'entry_revisions',
    sql: `SELECT entry_id, revision, type, title, content, applies_to, tags, refs, author_id, on_behalf_id,
                 stamped_ref, created_at
            FROM entry_revisions WHERE entry_id IN (${KEPT}) ORDER BY entry_id, revision`,
    people: ['author_id', 'on_behalf_id'],
  },
  {
    name: 'relations',
    sql: `SELECT id, from_id, to_id, kind, status, reason, created_by, created_at, decided_at
            FROM relations WHERE brain_id = $1 AND from_id IN (${KEPT}) AND to_id IN (${KEPT}) ORDER BY id`,
    people: ['created_by'],
  },
  {
    name: 'pages',
    sql: `SELECT id, address, type, title, summary, body, tags, status, superseded_by, revision, created_at, updated_at
            FROM pages WHERE brain_id = $1 ORDER BY id`,
    people: [],
  },
  {
    name: 'page_addresses',
    sql: `SELECT address, page_id, created_at FROM page_addresses WHERE brain_id = $1 ORDER BY address COLLATE "C"`,
    people: [],
  },
  {
    name: 'page_revisions',
    sql: `SELECT r.page_id, r.revision, r.address, r.type, r.title, r.summary, r.body, r.tags, r.status, r.sources,
                 r.links, r.kind, r.author_id, r.proposal_id, r.op_index, r.corrected, r.base_reviewed, r.note,
                 r.created_at, r.purged_by, r.purged_at, r.purged_reason, r.reason
            FROM page_revisions r JOIN pages p ON p.id = r.page_id
           WHERE p.brain_id = $1 ORDER BY r.page_id, r.revision`,
    people: ['author_id', 'purged_by'],
  },
  {
    name: 'page_links',
    sql: `SELECT from_page, kind, to_page, to_address FROM page_links WHERE brain_id = $1
           ORDER BY from_page, kind, to_page NULLS LAST, to_address COLLATE "C"`,
    people: [],
  },
  {
    name: 'page_sources',
    sql: `SELECT s.page_id, s.entry_id, s.url, s.title FROM page_sources s JOIN pages p ON p.id = s.page_id
           WHERE p.brain_id = $1 AND ${kept('s.entry_id')} ORDER BY s.page_id, s.entry_id NULLS LAST, s.url`,
    people: [],
  },
  {
    name: 'proposals',
    sql: `SELECT id, title, reason, author_id, agent, status, supersedes_id, superseded_by, collected, comment,
                 decided_by, decided_at, last_error, created_at, purged_by, purged_at, purged_reason
            FROM proposals WHERE brain_id = $1 ORDER BY id`,
    people: ['author_id', 'decided_by', 'purged_by'],
  },
  {
    name: 'proposal_ops',
    sql: `SELECT o.proposal_id, o.idx, o.op, o.status, o.corrected_by, o.base_reviewed_by, o.applied_page,
                 o.applied_revision
            FROM proposal_ops o JOIN proposals p ON p.id = o.proposal_id
           WHERE p.brain_id = $1 ORDER BY o.proposal_id, o.idx`,
    people: ['corrected_by', 'base_reviewed_by'],
  },
  {
    name: 'wiki_settings',
    sql: `SELECT guide, map_intro, stale_days, long_chars, maintenance_every, approvals_since, usage_note,
                 meaning_excluded
            FROM wiki_settings WHERE brain_id = $1`,
    people: [],
  },
  {
    name: 'wiki_log',
    sql: `SELECT id, at, actor_id, kind, proposal_id, summary, pages, reason
            FROM wiki_log WHERE brain_id = $1 ORDER BY at, id`,
    people: ['actor_id'],
  },
]

// An account column under its new name: what was an id is now a reference.
const refName = (column: string) => column.replace(/_id$/, '')

// Drops every mention of a left-out entry from a value read as JSON: a source {entryId}, or the id itself.
function without(v: unknown, gone: Set<string>): unknown {
  if (Array.isArray(v))
    return v
      .filter(
        (x) =>
          !(typeof x === 'string' && gone.has(x)) &&
          !(x && typeof x === 'object' && gone.has(String((x as Record<string, unknown>).entryId))),
      )
      .map((x) => without(x, gone))
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, without(x, gone)]))
  return v
}

export async function writeFaithful(db: Db, zip: Zip, o: ExportOptions): Promise<void> {
  const brainId = o.brain.id
  // The entries of this brain that do not come: only their ids, to take them out of what names them.
  const gone = new Set(
    (
      await db.query(
        `SELECT id FROM entries WHERE brain_id = $1 AND NOT (state = 'active' OR ($2 AND state = 'forgotten'))`,
        [brainId, o.includeForgotten],
      )
    ).map((r) => String(r.id)),
  )
  const refs = new Map<string, string>()
  const refOf = (id: unknown) => {
    if (id == null) return null
    let r = refs.get(String(id))
    if (!r) {
      r = `p${refs.size + 1}`
      refs.set(String(id), r)
    }
    return r
  }
  const counts: Record<string, number> = {}
  for (const k of KINDS) {
    const f = await zip.open(`${k.name}.ndjson`)
    let n = 0
    // Read as JSON by PostgreSQL itself (timestamps in UTC, arrays and JSON as they are).
    for await (const row of rowsOf<{ r: Record<string, unknown> }>(
      db,
      `SELECT to_jsonb(x) AS r FROM (${k.sql}) x`,
      k.sql.includes('$2') ? [brainId, o.includeForgotten] : [brainId],
    )) {
      const out: Record<string, unknown> = {}
      for (const [col, v] of Object.entries(row.r)) {
        if (k.people.includes(col)) out[refName(col)] = refOf(v)
        else out[col] = gone.size ? without(v, gone) : v
      }
      await f.write(`${JSON.stringify(out)}\n`)
      n += 1
    }
    await f.close()
    counts[k.name] = n
  }
  const people =
    // The email only of whoever is a member of the brain now (its curators see those anyway); someone who left
    // is there by reference and name (review of PR31).
    (
      await db.query(
        `SELECT a.id, a.kind, a.name, CASE WHEN m.account_id IS NOT NULL THEN a.email END AS email
         FROM accounts a LEFT JOIN memberships m ON m.account_id = a.id AND m.brain_id = $2
        WHERE a.id = ANY($1)`,
        [[...refs.keys()], brainId],
      )
    )
      .map((a) => ({
        ref: refs.get(String(a.id)) as string,
        kind: String(a.kind),
        name: String(a.name),
        email: a.email == null ? null : String(a.email),
      }))
      .sort((a, b) => Number(a.ref.slice(1)) - Number(b.ref.slice(1)))
  await zip.file(
    'manifest.json',
    `${JSON.stringify(
      {
        format: FAITHFUL_FORMAT,
        version: FAITHFUL_VERSION,
        release: o.release,
        exportedAt: o.at.toISOString(),
        includeForgotten: o.includeForgotten,
        brain: {
          slug: o.brain.slug,
          name: o.brain.name,
          description: o.brain.description,
          purpose: o.brain.purpose,
        },
        counts,
        people,
      },
      null,
      2,
    )}\n`,
  )
}
