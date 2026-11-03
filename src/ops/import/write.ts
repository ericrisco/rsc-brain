// Writing a documentation folder into a brain (plan §3.6), inside the import's one transaction: the notes in one
// closed session of the import, the pages each with its first revision (kind "import"), their addresses, sources,
// mentions and typed links, and the map's introduction. The plan (docs.ts) already redacted every text.
import { createHash } from 'node:crypto'
import { newId } from '../../core/ids.ts'
import type { Db } from '../../db/db.ts'
import type { Ctx } from '../../domain/context.ts'
import { mentionsOf } from '../../domain/wiki/model.ts'
import { normalize, redact } from '../../privacy/redact.ts'
import type { DocsPlan } from './docs.ts'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
// The client the journal names for what an import wrote.
export const IMPORT_CLIENT = 'rsc-brain import'

// The closed session everything an import writes into the journal belongs to.
export async function importSession(
  db: Db,
  ctx: Ctx,
  brainId: string,
  from: string,
  now: Date,
): Promise<string> {
  const id = newId('ses')
  await db.query(
    `INSERT INTO sessions (id, brain_id, account_id, credential_id, purpose, status, opened_at, last_activity_at,
       closed_at, client)
     VALUES ($1, $2, $3, $4, $5, 'closed', $6, $6, $6, $7)`,
    [
      id,
      brainId,
      ctx.who.accountId,
      ctx.who.credential.id,
      redact(`Import from ${from}`).text.slice(0, 500),
      now,
      IMPORT_CLIENT,
    ],
  )
  return id
}

export async function writeDocs(
  db: Db,
  ctx: Ctx,
  brainId: string,
  plan: DocsPlan,
  o: { from: string; now: Date },
): Promise<{ pages: number; entries: number; links: number; addresses: string[] }> {
  const { now } = o
  const byPath = new Map<string, string[]>()
  if (plan.notes.length) {
    const session = await importSession(db, ctx, brainId, o.from, now)
    for (const n of plan.notes) {
      const id = newId('ent')
      await db.query(
        `INSERT INTO entries (id, brain_id, session_id, type, title, content, tags, refs, author_id, credential_id,
           norm_hash, created_at, updated_at, client)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $13)`,
        [
          id,
          brainId,
          session,
          n.type,
          n.title,
          n.content,
          n.tags,
          [n.ref],
          ctx.who.accountId,
          ctx.who.credential.id,
          sha(normalize(`${n.title}\n${n.content}`)),
          now,
          IMPORT_CLIENT,
        ],
      )
      await db.query(
        `INSERT INTO entry_revisions (entry_id, revision, type, title, content, tags, refs, author_id, credential_id,
           created_at)
         VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, n.type, n.title, n.content, n.tags, [n.ref], ctx.who.accountId, ctx.who.credential.id, now],
      )
      byPath.set(n.path, [...(byPath.get(n.path) ?? []), id])
    }
  }
  const idOf = new Map<string, string>()
  for (const p of plan.pages) {
    const id = newId('pg')
    idOf.set(p.address, id)
    await db.query(
      `INSERT INTO pages (id, brain_id, address, type, title, summary, body, tags, status, revision, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $10)`,
      [id, brainId, p.address, p.type, p.title, p.summary, p.body, p.tags, p.status, now],
    )
    await db.query(
      'INSERT INTO page_addresses (brain_id, address, page_id, created_at) VALUES ($1, $2, $3, $4)',
      [brainId, p.address, id, now],
    )
  }
  let links = 0
  for (const p of plan.pages) {
    const id = idOf.get(p.address) as string
    if (p.supersededBy && idOf.has(p.supersededBy))
      await db.query('UPDATE pages SET superseded_by = $2 WHERE id = $1', [id, idOf.get(p.supersededBy)])
    const sources: Array<{ entryId: string } | { url: string }> = []
    for (const s of p.sources) {
      if ('url' in s) sources.push({ url: s.url })
      else for (const e of byPath.get(s.file) ?? []) sources.push({ entryId: e })
    }
    const kept = sources.slice(0, 50)
    for (const s of kept) {
      if ('entryId' in s)
        await db.query(
          'INSERT INTO page_sources (page_id, entry_id) VALUES ($1, $2) ON CONFLICT (page_id, entry_id) WHERE entry_id IS NOT NULL DO NOTHING',
          [id, s.entryId],
        )
      else
        await db.query(
          'INSERT INTO page_sources (page_id, url) VALUES ($1, $2) ON CONFLICT (page_id, url) WHERE url IS NOT NULL DO NOTHING',
          [id, s.url],
        )
    }
    // Only to pages of the import: what the body says in code ([[x]] as an example) is no link of the graph.
    for (const a of mentionsOf(p.body)) {
      if (a === p.address || !idOf.has(a)) continue
      links += Number(
        (
          await db.one(
            `INSERT INTO page_links (brain_id, from_page, kind, to_address) VALUES ($1, $2, 'mentions', $3)
             ON CONFLICT (from_page, to_address) WHERE to_address IS NOT NULL DO NOTHING RETURNING 1 AS n`,
            [brainId, id, a],
          )
        )?.n ?? 0,
      )
    }
    const typed = p.links.filter((l) => idOf.has(l.to) && l.to !== p.address)
    for (const l of typed)
      links += Number(
        (
          await db.one(
            `INSERT INTO page_links (brain_id, from_page, kind, to_page) VALUES ($1, $2, $3, $4)
             ON CONFLICT (from_page, kind, to_page) WHERE to_page IS NOT NULL DO NOTHING RETURNING 1 AS n`,
            [brainId, id, l.kind, idOf.get(l.to)],
          )
        )?.n ?? 0,
      )
    // The first revision, as the wiki's writer keeps one: content, sources and typed links as they stand.
    const revLinks = [...typed].sort((a, b) => (a.kind + a.to < b.kind + b.to ? -1 : 1))
    await db.query(
      `INSERT INTO page_revisions (page_id, revision, address, type, title, summary, body, tags, status, sources, links,
         kind, author_id, credential_id, created_at, note)
       VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'import', $11, $12, $13, $14)`,
      [
        id,
        p.address,
        p.type,
        p.title,
        p.summary,
        p.body,
        p.tags,
        p.status,
        JSON.stringify(kept),
        JSON.stringify(revLinks.map((l) => ({ kind: l.kind, to: l.to }))),
        ctx.who.accountId,
        ctx.who.credential.id,
        now,
        redact(`imported from ${p.path}`).text.slice(0, 500),
      ],
    )
  }
  if (plan.mapIntro !== null)
    await db.query(
      `INSERT INTO wiki_settings (brain_id, map_intro) VALUES ($1, $2)
       ON CONFLICT (brain_id) DO UPDATE SET map_intro = EXCLUDED.map_intro`,
      [brainId, plan.mapIntro],
    )
  return {
    pages: plan.pages.length,
    entries: plan.notes.length,
    links,
    addresses: plan.pages.map((p) => p.address),
  }
}
