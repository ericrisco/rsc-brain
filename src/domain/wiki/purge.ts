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
import { joinAsAdmin } from '../curation.ts'
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

export async function purgePageRevision(
  ctx: Ctx,
  slug: string,
  address: string,
  revision: number,
  reason: string,
): Promise<{
  address: string
  revision: number
  restoredTo: number | null
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
    const joined = await joinAsAdmin(c, brainId, 'joined to purge a wiki revision')
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`wiki:${brainId}`])
    const page = await db.one(
      `SELECT p.* FROM page_addresses a JOIN pages p ON p.id = a.page_id
        WHERE a.brain_id = $1 AND a.address = $2 FOR UPDATE OF p`,
      [brainId, address],
    )
    if (!page) throw pageNotFound(address)
    const rev = await db.one('SELECT * FROM page_revisions WHERE page_id = $1 AND revision = $2 FOR UPDATE', [
      page.id,
      revision,
    ])
    if (!rev) {
      throw new AppError(
        404,
        'revision_not_found',
        `Page "${page.address}" has no revision ${revision}.`,
        'See its history.',
      )
    }
    const now = ctx.clock()
    let restoredTo: number | null = null
    if (!rev.purged_at) {
      await db.query(
        `UPDATE page_revisions SET title = '[purged]', summary = '', body = '', tags = '{}', sources = '[]', links = '[]',
                note = NULL, purged_by = $3, purged_at = $4, purged_reason = $5
          WHERE page_id = $1 AND revision = $2`,
        [page.id, revision, ctx.who.accountId, now, why],
      )
      await scrubOp(db, rev.proposal_id, rev.op_index)
      // The current text was that revision's: the page goes back to the last revision left.
      if (Number(page.revision) === revision || (page.title === rev.title && page.body === rev.body)) {
        const prev = await db.one(
          `SELECT * FROM page_revisions WHERE page_id = $1 AND revision < $2 AND purged_at IS NULL
            ORDER BY revision DESC LIMIT 1`,
          [page.id, revision],
        )
        if (prev) {
          restoredTo = Number(prev.revision)
          await db.query(
            'UPDATE pages SET type = $2, title = $3, summary = $4, body = $5, tags = $6, updated_at = $7 WHERE id = $1',
            [page.id, prev.type, prev.title, prev.summary, prev.body, prev.tags, now],
          )
        } else {
          await db.query(
            `UPDATE pages SET title = '[purged]', summary = '', body = '', tags = '{}', status = 'retired', updated_at = $2
              WHERE id = $1`,
            [page.id, now],
          )
        }
        await db.query("DELETE FROM page_links WHERE from_page = $1 AND kind = 'mentions'", [page.id])
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
    return { address: String(page.address), revision, restoredTo, joined, backupsNote: BACKUPS }
  })
}

export async function purgeProposal(
  ctx: Ctx,
  id: string,
  reason: string,
): Promise<{ id: string; joined: boolean; backupsNote: string }> {
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
    return { id, joined, backupsNote: BACKUPS }
  })
}
