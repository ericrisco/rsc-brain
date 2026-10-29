// Purging wiki text that cannot stay (spec B2 «Historia», CA25): a page revision or a whole proposal,
// by the administration, in the web, joined to the brain (pack rule 3). The text goes from every copy
// (the revision, the page and its search index if it was current, the operation that wrote it, the log
// and activity labels); the mark of who, when and why stays. Backups keep it until they rotate.
import { AppError, conflict, invalid, notFound } from '../../core/errors.ts'
import { newId } from '../../core/ids.ts'
import type { Db, Row } from '../../db/db.ts'
import { redact } from '../../privacy/redact.ts'
import { audit } from '../audit.ts'
import { allow, type Ctx } from '../context.ts'
import { joinAsAdmin, scrubEntry } from '../curation.ts'
import { mentionsOf, type Source } from './model.ts'
import { pageNotFound } from './pages.ts'
import { webOnly } from './review.ts'

const BACKUPS = 'Backups taken before this purge still hold the text until they rotate out.'

function reasonOf(raw: string): string {
  const why = redact(raw.trim()).text
  if (!why || why.length > 500)
    throw invalid('Write why it is purged, in 1 to 500 characters.', 'Add the reason.')
  return why
}

// The operation that wrote a revision keeps only what it was, not what it said.
async function scrubOp(db: Db, proposalId: unknown, index: unknown): Promise<void> {
  if (proposalId == null || index == null) return
  await db.query(
    `UPDATE proposal_ops SET op = jsonb_build_object('op', op -> 'op', 'address', op -> 'address', 'purged', true)
      WHERE proposal_id = $1 AND idx = $2`,
    [proposalId, index],
  )
}

// The fields a revision holds text in. URL sources (their address and title) count as one field;
// sources that are journal entries are ids, not text, and stay.
// Where wiki text of a brain lives, for the scrub: each table with its text, text-array and JSON columns.
type Target = { table: string; scope: string; text: string[]; arrays: string[]; json: string[] }
const TARGETS: Target[] = [
  { table: 'pages', scope: 'brain_id = $1', text: ['title', 'summary', 'body'], arrays: ['tags'], json: [] },
  {
    table: 'page_revisions',
    scope: 'page_id IN (SELECT id FROM pages WHERE brain_id = $1)',
    text: ['title', 'summary', 'body', 'note'],
    arrays: ['tags'],
    json: ['sources', 'links'],
  },
  {
    table: 'page_sources',
    scope: 'page_id IN (SELECT id FROM pages WHERE brain_id = $1)',
    text: ['url', 'title'],
    arrays: [],
    json: [],
  },
  {
    table: 'proposals',
    scope: 'brain_id = $1',
    text: ['title', 'reason', 'comment', 'agent', 'last_error'],
    arrays: [],
    json: [],
  },
  {
    table: 'proposal_ops',
    scope: 'proposal_id IN (SELECT id FROM proposals WHERE brain_id = $1)',
    text: [],
    arrays: [],
    json: ['op'],
  },
  { table: 'wiki_log', scope: 'brain_id = $1', text: ['summary'], arrays: ['pages'], json: [] },
  { table: 'events', scope: 'brain_id = $1', text: ['label'], arrays: [], json: [] },
]
const MARK = '[purged]'

const pattern = (texts: string[]) =>
  new RegExp(texts.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'giu')

// Every string inside a value, replaced where it holds a purged text. Returns how many were found.
function scrubbed(v: unknown, re: RegExp): { value: unknown; hits: number } {
  if (typeof v === 'string') {
    const hits = v.match(re)?.length ?? 0
    return { value: hits ? v.replace(re, MARK) : v, hits }
  }
  if (Array.isArray(v)) {
    let hits = 0
    const value = v.map((x) => {
      const r = scrubbed(x, re)
      hits += r.hits
      return r.value
    })
    return { value, hits }
  }
  if (v && typeof v === 'object') {
    let hits = 0
    const value = Object.fromEntries(
      Object.entries(v).map(([k, x]) => {
        const r = scrubbed(x, re)
        hits += r.hits
        return [k, r.value]
      }),
    )
    return { value, hits }
  }
  return { value: v, hits: 0 }
}

// Scrubs (or only counts, when `dry`) every copy of the purged texts in a brain's wiki, in batches.
async function scrubWiki(db: Db, brainId: string, re: RegExp, dry: boolean): Promise<Record<string, number>> {
  const found: Record<string, number> = {}
  for (const t of TARGETS) {
    const cols = [...t.text, ...t.arrays, ...t.json]
    let after = '(0,0)'
    for (;;) {
      const rows = await db.query(
        `SELECT ctid::text AS _at, ${cols.join(', ')} FROM ${t.table}
          WHERE ${t.scope} AND ctid > $2::tid ORDER BY ctid LIMIT 500`,
        [brainId, after],
      )
      if (rows.length === 0) break
      after = String(rows.at(-1)?._at)
      for (const r of rows) {
        const sets: string[] = []
        const values: unknown[] = []
        for (const c of cols) {
          const out = scrubbed(r[c], re)
          if (out.hits === 0) continue
          found[t.table] = (found[t.table] ?? 0) + out.hits
          values.push(t.json.includes(c) ? JSON.stringify(out.value) : out.value)
          sets.push(`${c} = $${values.length + 1}`)
        }
        if (!dry && sets.length > 0) {
          await db.query(`UPDATE ${t.table} SET ${sets.join(', ')} WHERE ctid = $1::tid`, [r._at, ...values])
        }
      }
      if (rows.length < 500) break
    }
  }
  return found
}

// Purging wiki text (spec B2 «Historia», CA25). The administration names the revisions that cannot
// stay and the exact text that must go (a name, an id number): the revisions are emptied, the page
// goes back to the last revision left if its current one was purged, and the text is replaced by a
// mark, any case, wherever the brain's wiki holds it (pages, every revision, sources, proposals,
// the log, the activity), copies made by merges included. Before it commits, it checks that no copy
// is left; if one were, nothing is done.
export async function purgePageRevisions(
  ctx: Ctx,
  slug: string,
  target: { address: string; pageId?: string },
  purge: number[],
  texts: string[],
  reason: string,
): Promise<{
  address: string
  revisions: number[]
  scrubbed: Record<string, number>
  proposalIds: string[]
  joined: boolean
  backupsNote: string
}> {
  webOnly(ctx)
  await allow(ctx, 'entry.purge', {})
  const why = reasonOf(reason)
  const wanted = [...new Set(purge)].sort((a, b) => a - b)
  if (wanted.length === 0 || wanted.length > 1000)
    throw invalid('Name 1 to 1 000 revisions to purge.', 'Send "revisions".')
  const needles = [...new Set(texts.map((t) => t.trim()))]
  if (
    needles.length === 0 ||
    needles.length > 20 ||
    needles.some((t) => t.length < 3 || t.length > 500 || !t.isWellFormed())
  ) {
    throw invalid(
      'Name the text that must go, in "text": 1 to 20 pieces of 3 to 500 characters.',
      'Copy the exact words that cannot stay (a name, an id number), as they appear.',
    )
  }
  const re = pattern(needles)
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const brain = await db.one('SELECT id FROM brains WHERE slug = $1', [slug])
    if (!brain) throw notFound('brain')
    const brainId = String(brain.id)
    // By the page's own address (a merged page keeps its last one), never through a redirect, which
    // would purge the page it was merged into. Two pages with that address: say which, by id.
    const pages = await db.query(
      `SELECT * FROM pages WHERE brain_id = $1 AND address = $2 ${target.pageId ? 'AND id = $3' : ''} FOR UPDATE`,
      target.pageId ? [brainId, target.address, target.pageId] : [brainId, target.address],
    )
    if (pages.length === 0) throw pageNotFound(target.address)
    if (pages.length > 1) {
      const err = invalid(
        `Several pages have had the address "${target.address}".`,
        'Send "pageId" too: one of those listed in "problems".',
      )
      err.problems = pages.map((p) => ({ pageId: p.id, status: p.status }))
      throw err
    }
    const page = pages[0] as Row
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`wiki:${brainId}`])
    const revs = await db.query(
      'SELECT * FROM page_revisions WHERE page_id = $1 ORDER BY revision FOR UPDATE',
      [page.id],
    )
    const missing = wanted.filter((n) => !revs.some((r) => Number(r.revision) === n))
    if (missing.length > 0) {
      throw new AppError(
        404,
        'revision_not_found',
        `Page "${page.address}" has no revision ${missing.join(', ')}.`,
        'See its history.',
      )
    }
    // Addresses are identifiers that links rely on; text inside one is moved away first, by hand.
    const inAddress = await db.query(
      'SELECT address FROM page_addresses WHERE brain_id = $1 UNION SELECT to_address FROM page_links WHERE brain_id = $1 AND to_address IS NOT NULL',
      [brainId],
    )
    const hit = inAddress.find((r) => pattern(needles).test(String(r.address)))
    if (hit) {
      throw conflict(
        'text_in_address',
        `The text is part of the address "${hit.address}". Nothing was purged.`,
        'Move that page to another address first, then purge.',
      )
    }
    const joined = await joinAsAdmin(c, brainId, 'joined to purge a wiki revision')
    const now = ctx.clock()
    const proposalIds = new Set<string>()
    for (const n of wanted) {
      const r = revs.find((x) => Number(x.revision) === n) as Row
      if (r.purged_at) continue
      await db.query(
        `UPDATE page_revisions SET title = '[purged]', summary = '', body = '', tags = '{}', sources = '[]', links = '[]',
                note = NULL, purged_by = $3, purged_at = $4, purged_reason = $5
          WHERE page_id = $1 AND revision = $2`,
        [page.id, n, ctx.who.accountId, now, why],
      )
      await scrubOp(db, r.proposal_id, r.op_index)
      if (r.proposal_id != null) proposalIds.add(String(r.proposal_id))
    }
    // The current text was a purged revision's: the page goes back to the last revision left.
    const latest = revs.at(-1) as Row
    if (wanted.includes(Number(latest.revision))) {
      const left = (
        await db.query(
          'SELECT * FROM page_revisions WHERE page_id = $1 AND purged_at IS NULL ORDER BY revision DESC LIMIT 1',
          [page.id],
        )
      )[0]
      if (left) {
        await db.query(
          'UPDATE pages SET type = $2, title = $3, summary = $4, body = $5, tags = $6, updated_at = $7 WHERE id = $1',
          [page.id, left.type, left.title, left.summary, left.body, left.tags, now],
        )
        await db.query('DELETE FROM page_sources WHERE page_id = $1 AND url IS NOT NULL', [page.id])
        for (const x of (left.sources as Source[]) ?? []) {
          if ('url' in x) {
            await db.query(
              'INSERT INTO page_sources (page_id, url, title) VALUES ($1, $2, $3) ON CONFLICT (page_id, url) WHERE url IS NOT NULL DO NOTHING',
              [page.id, x.url, x.title ?? null],
            )
          }
        }
      } else {
        await db.query(
          `UPDATE pages SET title = '[purged]', summary = '', body = '', tags = '{}', status = 'retired', updated_at = $2 WHERE id = $1`,
          [page.id, now],
        )
        await db.query('DELETE FROM page_sources WHERE page_id = $1 AND url IS NOT NULL', [page.id])
      }
    }
    const found = await scrubWiki(db, brainId, re, false)
    // Mentions follow the body as it now stands.
    const body = String(
      (await db.one('SELECT body, address FROM pages WHERE id = $1', [page.id]))?.body ?? '',
    )
    await db.query("DELETE FROM page_links WHERE from_page = $1 AND kind = 'mentions'", [page.id])
    for (const a of mentionsOf(body)) {
      if (a === page.address) continue
      await db.query(
        `INSERT INTO page_links (brain_id, from_page, kind, to_address) VALUES ($1, $2, 'mentions', $3)
         ON CONFLICT (from_page, to_address) WHERE to_address IS NOT NULL DO NOTHING`,
        [brainId, page.id, a],
      )
    }
    const left = await scrubWiki(db, brainId, re, true)
    if (Object.keys(left).length > 0) {
      throw conflict(
        'purge_incomplete',
        'Some copy of the text could not be removed; nothing was purged.',
        'Tell the administration of this installation; this should not happen.',
      )
    }
    await audit(db, {
      at: now,
      actorId: ctx.who.accountId,
      credentialId: ctx.who.credential.id,
      action: 'wiki.purge',
      brainId,
      target: `${page.id}#${wanted.join(',')}`,
      outcome: 'ok',
      detail: why,
    })
    await db.query(
      `INSERT INTO wiki_log (id, brain_id, at, actor_id, kind, summary, pages) VALUES ($6, $1, $2, $3, 'purge', $4, $5)`,
      [
        brainId,
        now,
        ctx.who.accountId,
        `Purged revision ${wanted.join(', ')} of ${page.address}`,
        [String(page.address)],
        newId('wlg'),
      ],
    )
    return {
      address: String(page.address),
      revisions: wanted,
      scrubbed: found,
      // The proposals that wrote them keep their reasons for the record; their titles and operations were
      // scrubbed of the text. Purge those proposals too if they should not stay at all.
      proposalIds: [...proposalIds],
      joined,
      backupsNote: BACKUPS,
    }
  })
}

export async function purgeProposal(
  ctx: Ctx,
  id: string,
  reason: string,
): Promise<{
  id: string
  joined: boolean
  revisions: { address: string; revision: number }[]
  backupsNote: string
}> {
  webOnly(ctx)
  await allow(ctx, 'entry.purge', {})
  const why = reasonOf(reason)
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const row = (await db.one('SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [id])) as Row | undefined
    if (!row) throw notFound('proposal')
    const brainId = String(row.brain_id)
    const joined = await joinAsAdmin(c, brainId, 'joined to purge a wiki proposal')
    if (!row.purged_at) {
      const now = ctx.clock()
      await db.query(
        `UPDATE proposals SET title = '[purged]', reason = '', comment = NULL, agent = NULL, last_error = NULL,
                status = CASE WHEN status = 'pending' THEN 'withdrawn' ELSE status END,
                purged_by = $2, purged_at = $3, purged_reason = $4
          WHERE id = $1`,
        [id, ctx.who.accountId, now, why],
      )
      await db.query(
        `UPDATE proposal_ops SET op = jsonb_build_object('op', op -> 'op', 'address', op -> 'address', 'purged', true)
          WHERE proposal_id = $1`,
        [id],
      )
      await db.query("UPDATE wiki_log SET summary = '[purged proposal]' WHERE proposal_id = $1", [id])
      // The corrections a return left in the journal quote it: they go too.
      for (const e of await db.query(
        "SELECT id FROM entries WHERE brain_id = $1 AND type = 'correction' AND $2 = ANY(refs) AND state <> 'purged'",
        [brainId, id],
      )) {
        await scrubEntry(c, String(e.id), why)
      }
      await db.query('DELETE FROM events WHERE target_id = $1', [id])
      await audit(db, {
        at: now,
        actorId: ctx.who.accountId,
        credentialId: ctx.who.credential.id,
        action: 'wiki.purge',
        brainId,
        target: id,
        outcome: 'ok',
        detail: why,
      })
    }
    // The page revisions it wrote are listed: purge those too if they carry the text.
    const revisions = await db.query(
      'SELECT p.address, r.revision FROM page_revisions r JOIN pages p ON p.id = r.page_id WHERE r.proposal_id = $1 ORDER BY p.address, r.revision',
      [id],
    )
    return {
      id,
      joined,
      revisions: revisions.map((r) => ({ address: String(r.address), revision: Number(r.revision) })),
      backupsNote: BACKUPS,
    }
  })
}
