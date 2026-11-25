// «Review later» (spec learning-memory A1, A2; plan §2.4): every change to the wiki that a person in the web did not make
// — a proposal applied at once, a key's direct write, a key's decision on parts that waited — is recorded as one change
// with its parts, one per page it touched, and what each page was before (the snapshot of the one writer of pages).
// Its pages stay «unreviewed» while their revision is past the last one a person saw (pages.reviewed_revision).
import { newId } from '../../core/ids.ts'
import type { Db, Row } from '../../db/db.ts'
import { type Ctx, personInWeb } from '../context.ts'
import type { PageBefore, Revised } from './apply.ts'
import type { Source } from './model.ts'
import { keyName } from './writers.ts'

// A page is unreviewed while a change no person saw left it at a newer revision (CA-A9).
export const isUnreviewed = (row: Row): boolean =>
  row.reviewed_revision != null && Number(row.revision) > Number(row.reviewed_revision)

// SQL of the same, for a page alias.
export const unreviewedSql = (p: string) => `(${p}.revision > ${p}.reviewed_revision)`

// Records a change for review, inside the caller's transaction, right after the writer applied it. A person in the web
// records nothing (their own gesture is reviewed): null. Otherwise the change's id, for the answer's «undo».
export async function recordChange(
  db: Db,
  ctx: Ctx,
  c: { brainId: string; logId: string; proposalId?: string | null; before: PageBefore[]; revised: Revised[] },
): Promise<string | null> {
  if (personInWeb(ctx) || c.revised.length === 0) return null
  const id = newId('chg')
  const now = ctx.clock()
  await db.query(
    `INSERT INTO wiki_changes (id, brain_id, log_id, proposal_id, actor_id, credential_id, key_name, ref, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      c.brainId,
      c.logId,
      c.proposalId ?? null,
      ctx.who.accountId,
      ctx.who.credential.id,
      (await keyName(db, ctx)).slice(0, 200),
      ctx.who.credential.ref?.slice(0, 200) ?? null,
      now,
    ],
  )
  const last = new Map<string, Revised>()
  const first = new Map<string, Revised>()
  for (const r of c.revised) {
    last.set(r.pageId, r)
    if (!first.has(r.pageId)) first.set(r.pageId, r)
  }
  // One part per page the change revised, in the order the writer first locked them.
  let part = 0
  for (const b of c.before) {
    const after = last.get(b.pageId)
    if (!after) continue
    const now = await db.query<{ address: string }>('SELECT address FROM page_addresses WHERE page_id = $1', [
      b.pageId,
    ])
    const had = new Set(b.addresses)
    const added = now.map((a) => a.address).filter((a) => !had.has(a))
    const sourcesNow = await db.query<{ entry_id: string }>(
      'SELECT entry_id FROM page_sources WHERE page_id = $1 AND entry_id IS NOT NULL',
      [b.pageId],
    )
    let sourcesBefore = new Set<string>()
    if (b.revision !== null) {
      const r = await db.one<{ sources: Source[] }>(
        'SELECT sources FROM page_revisions WHERE page_id = $1 AND revision = $2',
        [b.pageId, b.revision],
      )
      sourcesBefore = new Set((r?.sources ?? []).flatMap((s) => ('entryId' in s ? [s.entryId] : [])))
    }
    const sourcesAdded = sourcesNow.map((s) => s.entry_id).filter((e) => !sourcesBefore.has(e))
    await db.query(
      `INSERT INTO wiki_change_parts (change_id, part, op_index, page_id, created, revision_before, revision_after,
         address_before, address_after, status_before, superseded_by_before, addresses_before, addresses_added,
         links_in_before, sources_added)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        id,
        part,
        first.get(b.pageId)?.index ?? null,
        b.pageId,
        b.created,
        b.revision,
        after.revision,
        b.created ? null : b.address,
        after.address,
        b.status,
        b.supersededBy,
        JSON.stringify(b.addresses),
        JSON.stringify(added),
        JSON.stringify(b.linksIn),
        JSON.stringify(sourcesAdded),
      ],
    )
    part += 1
  }
  await db.query('UPDATE wiki_log SET change_id = $2 WHERE id = $1', [c.logId, id])
  return id
}
