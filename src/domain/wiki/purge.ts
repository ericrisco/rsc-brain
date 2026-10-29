// Purging wiki text that cannot stay (spec B2 «Historia», CA25): a page revision or a whole proposal,
// by the administration, in the web, joined to the brain (pack rule 3). The text goes from every copy
// (the revision, the page and its search index if it was current, the operation that wrote it, the log
// and activity labels); the mark of who, when and why stays. Backups keep it until they rotate.
import { AppError, invalid, notFound } from '../../core/errors.ts'
import { newId } from '../../core/ids.ts'
import type { Db, Row } from '../../db/db.ts'
import { redact } from '../../privacy/redact.ts'
import { audit } from '../audit.ts'
import { allow, type Ctx } from '../context.ts'
import { joinAsAdmin, scrubEntry } from '../curation.ts'
import { mentionsOf, type Source, sourceKey } from './model.ts'
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

type Snapshot = { title: string; summary: string; body: string; tags: string[]; sources: Source[] }
const TEXT = ['title', 'summary', 'body'] as const

const snap = (r: Row): Snapshot => ({
  title: String(r.title),
  summary: String(r.summary),
  body: String(r.body),
  tags: (r.tags as string[]) ?? [],
  sources: (r.sources as Source[]) ?? [],
})

// Purging what one revision brought in: each text field it changed (and the tags, and the sources it
// added) goes from that revision and from every later one that still carried it, which falls back to
// the last clean value of that field. The page ends as its last revision, cleaned the same way.
export async function purgePageRevision(
  ctx: Ctx,
  slug: string,
  target: { address: string; pageId?: string },
  revision: number,
  reason: string,
): Promise<{
  address: string
  revision: number
  cleaned: number[]
  proposalId: string | null
  joined: boolean
  backupsNote: string
}> {
  webOnly(ctx)
  await allow(ctx, 'entry.purge', {})
  const why = reasonOf(reason)
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
    const joined = await joinAsAdmin(c, brainId, 'joined to purge a wiki revision')
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`wiki:${brainId}`])
    const revs = await db.query(
      'SELECT * FROM page_revisions WHERE page_id = $1 ORDER BY revision FOR UPDATE',
      [page.id],
    )
    const rev = revs.find((r) => Number(r.revision) === revision)
    if (!rev) {
      throw new AppError(
        404,
        'revision_not_found',
        `Page "${page.address}" has no revision ${revision}.`,
        'See its history.',
      )
    }
    const cleaned: number[] = []
    if (!rev.purged_at) {
      const now = ctx.clock()
      const before = revs.filter((r) => Number(r.revision) < revision && !r.purged_at).at(-1)
      const bad = snap(rev)
      const prev = before ? snap(before) : null
      // What this revision brought in, field by field.
      const brought = new Set<string>(TEXT.filter((f) => !prev || prev[f] !== bad[f]))
      const tagsBrought = !prev || JSON.stringify(prev.tags) !== JSON.stringify(bad.tags)
      const prevKeys = new Set((prev?.sources ?? []).map(sourceKey))
      const newSources = new Set(bad.sources.map(sourceKey).filter((k) => !prevKeys.has(k)))
      const clean: Snapshot = prev ?? { title: '[purged]', summary: '', body: '', tags: [], sources: [] }
      await db.query(
        `UPDATE page_revisions SET title = '[purged]', summary = '', body = '', tags = '{}', sources = '[]', links = '[]',
                note = NULL, purged_by = $3, purged_at = $4, purged_reason = $5
          WHERE page_id = $1 AND revision = $2`,
        [page.id, revision, ctx.who.accountId, now, why],
      )
      await scrubOp(db, rev.proposal_id, rev.op_index)
      // Later revisions that still carry what it brought fall back to the last clean value.
      let last: Snapshot = clean
      for (const r of revs.filter((x) => Number(x.revision) > revision && !x.purged_at)) {
        const s = snap(r)
        const fixed: Snapshot = { ...s }
        let touched = false
        for (const f of TEXT) {
          if (brought.has(f) && s[f] === bad[f]) {
            fixed[f] = last[f]
            touched = true
          }
        }
        if (tagsBrought && JSON.stringify(s.tags) === JSON.stringify(bad.tags)) {
          fixed.tags = last.tags
          touched = true
        }
        const kept = s.sources.filter((x) => !newSources.has(sourceKey(x)))
        if (kept.length !== s.sources.length) {
          fixed.sources = kept
          touched = true
        }
        if (touched) {
          cleaned.push(Number(r.revision))
          await db.query(
            `UPDATE page_revisions SET title = $3, summary = $4, body = $5, tags = $6, sources = $7
              WHERE page_id = $1 AND revision = $2`,
            [
              page.id,
              r.revision,
              fixed.title,
              fixed.summary,
              fixed.body,
              fixed.tags,
              JSON.stringify(fixed.sources),
            ],
          )
          await scrubOp(db, r.proposal_id, r.op_index)
        }
        last = fixed
      }
      // The page is its last revision, cleaned: content, sources and the mentions of its body.
      const final = revs.some((x) => Number(x.revision) > revision && !x.purged_at) ? last : clean
      await db.query(
        `UPDATE pages SET title = $2, summary = $3, body = $4, tags = $5, updated_at = $6,
                status = CASE WHEN $2 = '[purged]' AND $4 = '' THEN 'retired' ELSE status END
          WHERE id = $1`,
        [page.id, final.title, final.summary, final.body, final.tags, now],
      )
      await db.query('DELETE FROM page_sources WHERE page_id = $1 AND url IS NOT NULL', [page.id])
      for (const s of final.sources) {
        if ('url' in s) {
          await db.query(
            'INSERT INTO page_sources (page_id, url, title) VALUES ($1, $2, $3) ON CONFLICT (page_id, url) WHERE url IS NOT NULL DO NOTHING',
            [page.id, s.url, s.title ?? null],
          )
        }
      }
      await db.query("DELETE FROM page_links WHERE from_page = $1 AND kind = 'mentions'", [page.id])
      for (const a of mentionsOf(final.body)) {
        if (a === page.address) continue
        await db.query(
          `INSERT INTO page_links (brain_id, from_page, kind, to_address) VALUES ($1, $2, 'mentions', $3)
           ON CONFLICT (from_page, to_address) WHERE to_address IS NOT NULL DO NOTHING`,
          [brainId, page.id, a],
        )
      }
      await audit(db, {
        at: now,
        actorId: ctx.who.accountId,
        credentialId: ctx.who.credential.id,
        action: 'wiki.purge',
        brainId,
        target: `${page.id}#${revision}`,
        outcome: 'ok',
        detail: why,
      })
      await db.query(
        `INSERT INTO wiki_log (id, brain_id, at, actor_id, kind, summary, pages)
         VALUES ($6, $1, $2, $3, 'purge', $4, $5)`,
        [
          brainId,
          now,
          ctx.who.accountId,
          `Purged revision ${revision} of ${page.address}`,
          [String(page.address)],
          newId('wlg'),
        ],
      )
    }
    return {
      address: String(page.address),
      revision,
      cleaned,
      // The proposal that wrote it keeps its title and reason: purge it too if they carry the text.
      proposalId: rev.proposal_id == null ? null : String(rev.proposal_id),
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
