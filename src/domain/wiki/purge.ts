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
type Fields = { title: string; summary: string; body: string; tags: string; urls: string }

const urlsOf = (sources: Source[]) =>
  JSON.stringify(
    sources
      .filter((x): x is { url: string; title?: string } => 'url' in x)
      .map((x) => [x.url, x.title ?? null])
      .sort(),
  )
const fieldsOf = (r: Row): Fields => ({
  title: String(r.title),
  summary: String(r.summary),
  body: String(r.body),
  tags: JSON.stringify((r.tags as string[]) ?? []),
  urls: urlsOf((r.sources as Source[]) ?? []),
})
const EMPTY: Fields = { title: '[purged]', summary: '', body: '', tags: '[]', urls: '[]' }

// Purging revisions (spec B2 «Historia», CA25). Field by field, walking the history: a later revision
// that holds a purged value as it was is cleaned back to the last clean value (a link-only change, a
// revert to it); one that holds a piece of purged text inside new text may still hold it, so the purge
// refuses and names it, to be purged together. Tags and source titles it added are simply removed.
// Never a success while some revision or the page still holds what was purged.
export async function purgePageRevisions(
  ctx: Ctx,
  slug: string,
  target: { address: string; pageId?: string },
  purge: number[],
  reason: string,
): Promise<{
  address: string
  revisions: number[]
  cleaned: number[]
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
    const toPurge = new Set(wanted.filter((n) => !revs.find((r) => Number(r.revision) === n)?.purged_at))
    const first = Math.min(...wanted)
    // The text a purged revision brought into a field: what is left of its value once the prefix and
    // suffix it shares with the clean value are taken off.
    const brought = (was: string, now: string): string => {
      let i = 0
      while (i < was.length && i < now.length && was[i] === now[i]) i += 1
      let j = 0
      while (j < was.length - i && j < now.length - i && was[was.length - 1 - j] === now[now.length - 1 - j])
        j += 1
      return now.slice(i, now.length - j).trim()
    }
    const clean: Fields = { ...EMPTY }
    // Every value a purged revision held, and the pieces of text it brought in: they may come back later
    // (a revert to it, a copy), so every later revision is checked against them, not only the next.
    const purgedValues: Record<'title' | 'summary' | 'body', Set<string>> = {
      title: new Set(),
      summary: new Set(),
      body: new Set(),
    }
    const pieces: Record<'title' | 'summary' | 'body', string[]> = { title: [], summary: [], body: [] }
    const addedTags = new Set<string>()
    const addedUrls = new Map<string, string | null>() // url -> its title as the purged revision left it
    const fixes = new Map<number, Partial<Fields>>()
    const carrying = new Set<number>()
    let seeded = false
    for (const r of revs) {
      const n = Number(r.revision)
      if (r.purged_at && !toPurge.has(n)) continue
      const f = fieldsOf(r)
      if (n < first) {
        Object.assign(clean, f)
        seeded = true
        continue
      }
      if (toPurge.has(n)) {
        for (const k of ['title', 'summary', 'body'] as const) {
          const base = clean[k]
          if (!seeded || f[k] !== base) {
            const piece = seeded ? brought(base, f[k]) : f[k].trim()
            if (piece) pieces[k].push(piece)
            purgedValues[k].add(f[k])
          }
        }
        const cleanTags = new Set(JSON.parse(clean.tags) as string[])
        for (const t of JSON.parse(f.tags) as string[]) if (!cleanTags.has(t)) addedTags.add(t)
        const cleanUrls = new Map(JSON.parse(clean.urls) as [string, string | null][])
        for (const [u, t] of JSON.parse(f.urls) as [string, string | null][]) {
          if (!cleanUrls.has(u) || cleanUrls.get(u) !== t) addedUrls.set(u, t)
        }
        seeded = true
        continue
      }
      // A revision after: holds a purged value as it was (cleaned back to the last clean value), holds
      // a purged piece inside new text (may still hold it: the purge is refused), or holds neither.
      const fx: Partial<Fields> = {}
      for (const k of ['title', 'summary', 'body'] as const) {
        if (purgedValues[k].has(f[k])) {
          fx[k] = clean[k]
        } else if (pieces[k].some((p) => f[k].includes(p))) {
          carrying.add(n)
        } else {
          clean[k] = f[k]
        }
      }
      const tags = JSON.parse(f.tags) as string[]
      const keptTags = tags.filter((t) => !addedTags.has(t))
      if (keptTags.length !== tags.length) fx.tags = JSON.stringify(keptTags)
      const cleanUrls = new Map(JSON.parse(clean.urls) as [string, string | null][])
      const urls = JSON.parse(f.urls) as [string, string | null][]
      const keptUrls = urls.flatMap(([u, t]): [string, string | null][] => {
        if (!addedUrls.has(u) || addedUrls.get(u) !== t) return [[u, t]]
        return cleanUrls.has(u) ? [[u, cleanUrls.get(u) ?? null]] : []
      })
      if (JSON.stringify(keptUrls) !== JSON.stringify(urls)) fx.urls = JSON.stringify(keptUrls.sort())
      if (Object.keys(fx).length > 0) fixes.set(n, fx)
      clean.tags = JSON.stringify(keptTags)
      clean.urls = JSON.stringify(keptUrls.sort())
    }
    if (carrying.size > 0) {
      const list = [...carrying].sort((a, b) => a - b)
      const err = conflict(
        'purge_incomplete',
        `Revisions ${list.join(', ')} edited on top of what you purge, so they may still hold it. Nothing was purged.`,
        `Purge them together: send "revisions": [${[...wanted, ...list].sort((a, b) => a - b).join(', ')}].`,
      )
      err.problems = list.map((n) => ({ revision: n }))
      throw err
    }
    const joined = await joinAsAdmin(c, brainId, 'joined to purge a wiki revision')
    const now = ctx.clock()
    const proposalIds = new Set<string>()
    for (const n of toPurge) {
      const r = revs.find((x) => Number(x.revision) === n) as Row
      await db.query(
        `UPDATE page_revisions SET title = '[purged]', summary = '', body = '', tags = '{}', sources = '[]', links = '[]',
                note = NULL, purged_by = $3, purged_at = $4, purged_reason = $5
          WHERE page_id = $1 AND revision = $2`,
        [page.id, n, ctx.who.accountId, now, why],
      )
      await scrubOp(db, r.proposal_id, r.op_index)
      if (r.proposal_id != null) proposalIds.add(String(r.proposal_id))
    }
    const withFields = (r: Row, fx: Partial<Fields>) => {
      const f = { ...fieldsOf(r), ...fx }
      const entrySources = ((r.sources as Source[]) ?? []).filter((x) => 'entryId' in x)
      const urls = (JSON.parse(f.urls) as [string, string | null][]).map(([url, title]) =>
        title === null ? { url } : { url, title },
      )
      return { f, tags: JSON.parse(f.tags) as string[], sources: [...entrySources, ...urls] as Source[] }
    }
    for (const [n, fx] of fixes) {
      const r = revs.find((x) => Number(x.revision) === n) as Row
      const w = withFields(r, fx)
      await db.query(
        'UPDATE page_revisions SET title = $3, summary = $4, body = $5, tags = $6, sources = $7 WHERE page_id = $1 AND revision = $2',
        [page.id, n, w.f.title, w.f.summary, w.f.body, w.tags, JSON.stringify(w.sources)],
      )
      await scrubOp(db, r.proposal_id, r.op_index)
    }
    // The page is its last revision as it now stands (or the last clean values, if that one was purged).
    const latest = (await db.one(
      'SELECT * FROM page_revisions WHERE page_id = $1 ORDER BY revision DESC LIMIT 1',
      [page.id],
    )) as Row
    const final = latest.purged_at
      ? withFields({ ...latest, ...clean, tags: JSON.parse(clean.tags), sources: [] } as Row, {
          urls: clean.urls,
        })
      : withFields(latest, {})
    await db.query(
      `UPDATE pages SET title = $2, summary = $3, body = $4, tags = $5, updated_at = $6,
              status = CASE WHEN $2 = '[purged]' AND $4 = '' THEN 'retired' ELSE status END
        WHERE id = $1`,
      [page.id, final.f.title, final.f.summary, final.f.body, final.tags, now],
    )
    await db.query('DELETE FROM page_sources WHERE page_id = $1 AND url IS NOT NULL', [page.id])
    for (const x of final.sources) {
      if ('url' in x) {
        await db.query(
          'INSERT INTO page_sources (page_id, url, title) VALUES ($1, $2, $3) ON CONFLICT (page_id, url) WHERE url IS NOT NULL DO NOTHING',
          [page.id, x.url, x.title ?? null],
        )
      }
    }
    await db.query("DELETE FROM page_links WHERE from_page = $1 AND kind = 'mentions'", [page.id])
    for (const a of mentionsOf(final.f.body)) {
      if (a === page.address) continue
      await db.query(
        `INSERT INTO page_links (brain_id, from_page, kind, to_address) VALUES ($1, $2, 'mentions', $3)
         ON CONFLICT (from_page, to_address) WHERE to_address IS NOT NULL DO NOTHING`,
        [brainId, page.id, a],
      )
    }
    if (toPurge.size > 0) {
      await audit(db, {
        at: now,
        actorId: ctx.who.accountId,
        credentialId: ctx.who.credential.id,
        action: 'wiki.purge',
        brainId,
        target: `${page.id}#${[...toPurge].join(',')}`,
        outcome: 'ok',
        detail: why,
      })
      await db.query(
        `INSERT INTO wiki_log (id, brain_id, at, actor_id, kind, summary, pages) VALUES ($6, $1, $2, $3, 'purge', $4, $5)`,
        [
          brainId,
          now,
          ctx.who.accountId,
          `Purged revision ${[...toPurge].join(', ')} of ${page.address}`,
          [String(page.address)],
          newId('wlg'),
        ],
      )
    }
    return {
      address: String(page.address),
      revisions: wanted,
      cleaned: [...fixes.keys()].sort((a, b) => a - b),
      // The proposals that wrote them keep their titles and reasons: purge those too if they carry it.
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
