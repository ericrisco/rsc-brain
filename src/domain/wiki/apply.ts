// The one writer of wiki pages (spec B2). An approved proposal, a curator's direct edit and going back
// to a revision all come through here, inside the caller's transaction: every operation applies, or
// the error rolls everything back (CA5). Each change leaves a revision of the page it changed, with
// its sources and typed links as they stood, and the whole call leaves one line in the log.
import { AppError } from '../../core/errors.ts'
import { newId } from '../../core/ids.ts'
import type { Db, Row } from '../../db/db.ts'
import type { Ctx } from '../context.ts'
import { emit } from '../events.ts'
import { type LinkKind, mentionsOf, type Op, type Source, sourceKey } from './model.ts'
import { uses } from './review.ts'

export class ApplyError extends AppError {
  constructor(index: number | undefined, message: string) {
    super(
      409,
      'apply_failed',
      index === undefined ? message : `Operation ${index}: ${message}`,
      'Nothing was applied. Correct the operation, or return it to its author.',
    )
  }
}

export type ApplyItem = { op: Op; index?: number; corrected?: boolean; baseReviewed?: boolean }
export type ApplyMeta = {
  // 'write': a key with the permission wrote it directly (spec v0.6).
  kind: 'proposal' | 'direct' | 'revert' | 'write'
  proposalId?: string
  summary: string
  // Why, for a change by hand or a restore (a proposal keeps its reasons on itself and its operations).
  reason?: string
  // The key that wrote it directly, by its name then (spec v0.6 «escrito directamente por <clave>»).
  keyName?: string
  // A maintenance pass: an approved maintenance proposal or a write marked as one (spec v0.6 «Limpieza diaria»).
  maintenance?: boolean
}
export type Revised = { index?: number; pageId: string; address: string; revision: number }

// The order operations apply in: the proposal's own, except that an operation using an address
// another operation brings into being (a page it creates, the new address of a move) goes after it, so
// a link listed before the page it points at still applies. Approval grouping (dependencies) is a
// different question: "edit y" before "merge y into x" must still edit y, then merge.
export function applyOrder(ops: Op[]): number[] {
  const born = ops.map((o) => (o.op === 'create' ? [o.address] : o.op === 'move' ? [o.to] : []))
  const after = ops.map((o, i) => {
    const mine = new Set(uses(o))
    return ops.flatMap((_, j) => (j !== i && (born[j] ?? []).some((a) => mine.has(a)) ? [j] : []))
  })
  const done = new Set<number>()
  const out: number[] = []
  while (out.length < ops.length) {
    const next = ops.findIndex((_, i) => !done.has(i) && (after[i] ?? []).every((j) => done.has(j)))
    const pick = next === -1 ? ops.findIndex((_, i) => !done.has(i)) : next
    done.add(pick)
    out.push(pick)
  }
  return out
}

export async function applyOps(
  ctx: Ctx,
  db: Db,
  brainId: string,
  items: ApplyItem[],
  meta: ApplyMeta,
): Promise<{ revised: Revised[]; pages: string[]; logId: string }> {
  // One writer per brain's wiki at a time: approvals, direct edits and reverts queue here.
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`wiki:${brainId}`])
  const now = ctx.clock()
  const revised: Revised[] = []
  const touched = new Set<string>()
  const sorted = applyOrder(items.map((x) => x.op)).map((i) => ({ it: items[i] as ApplyItem }))
  // Each page's revision before this call: an edit's baseRevision is checked against it, not against
  // what earlier operations of the same approval made of the page (a move, then an edit of it).
  const startRevision = new Map<string, number>()

  const fail = (it: ApplyItem, message: string): never => {
    throw new ApplyError(it.index, message)
  }
  const page = async (it: ApplyItem, address: string): Promise<Row> => {
    const r = await db.one(
      `SELECT p.* FROM page_addresses a JOIN pages p ON p.id = a.page_id
        WHERE a.brain_id = $1 AND a.address = $2 FOR UPDATE OF p`,
      [brainId, address],
    )
    if (r && !startRevision.has(String(r.id))) startRevision.set(String(r.id), Number(r.revision))
    return r ?? fail(it, `there is no page at "${address}".`)
  }
  const checkEntries = async (it: ApplyItem, sources: Source[]) => {
    const ids = sources.flatMap((s) => ('entryId' in s ? [s.entryId] : []))
    if (ids.length === 0) return
    const rows = await db.query(
      "SELECT id FROM entries WHERE brain_id = $1 AND id = ANY($2) AND state <> 'purged'",
      [brainId, ids],
    )
    const found = new Set(rows.map((r) => String(r.id)))
    for (const id of ids) if (!found.has(id)) fail(it, `the source ${id} is not an entry of this brain.`)
  }
  const setSources = async (pageId: string, sources: Source[]) => {
    await db.query('DELETE FROM page_sources WHERE page_id = $1', [pageId])
    await addSources(pageId, sources)
  }
  const addSources = async (pageId: string, sources: Source[]) => {
    for (const s of sources) {
      if ('entryId' in s) {
        await db.query(
          'INSERT INTO page_sources (page_id, entry_id) VALUES ($1, $2) ON CONFLICT (page_id, entry_id) WHERE entry_id IS NOT NULL DO NOTHING',
          [pageId, s.entryId],
        )
      } else {
        await db.query(
          'INSERT INTO page_sources (page_id, url, title) VALUES ($1, $2, $3) ON CONFLICT (page_id, url) WHERE url IS NOT NULL DO NOTHING',
          [pageId, s.url, s.title ?? null],
        )
      }
    }
  }
  const setMentions = async (p: { id: string; address: string }, body: string) => {
    await db.query("DELETE FROM page_links WHERE from_page = $1 AND kind = 'mentions'", [p.id])
    for (const a of mentionsOf(body)) {
      if (a === p.address) continue
      await db.query(
        `INSERT INTO page_links (brain_id, from_page, kind, to_address) VALUES ($1, $2, 'mentions', $3)
         ON CONFLICT (from_page, to_address) WHERE to_address IS NOT NULL DO NOTHING`,
        [brainId, p.id, a],
      )
    }
  }
  const addLink = async (it: ApplyItem, from: Row, kind: LinkKind, to: Row) => {
    if (from.id === to.id) fail(it, 'a page cannot link to itself.')
    await db.query(
      `INSERT INTO page_links (brain_id, from_page, kind, to_page) VALUES ($1, $2, $3, $4)
       ON CONFLICT (from_page, kind, to_page) WHERE to_page IS NOT NULL DO NOTHING`,
      [brainId, from.id, kind, to.id],
    )
  }
  // A revision of the page as it now stands: content, current sources and typed links.
  const revise = async (it: ApplyItem, pageId: string, note?: string) => {
    const p = (await db.one('SELECT * FROM pages WHERE id = $1', [pageId])) as Row
    const sources = await db.query(
      'SELECT entry_id, url, title FROM page_sources WHERE page_id = $1 ORDER BY entry_id NULLS LAST, url',
      [pageId],
    )
    const links = await db.query(
      `SELECT l.kind, t.address AS to FROM page_links l JOIN pages t ON t.id = l.to_page
        WHERE l.from_page = $1 ORDER BY l.kind, t.address`,
      [pageId],
    )
    await db.query(
      `INSERT INTO page_revisions (page_id, revision, address, type, title, summary, body, tags, status, sources, links,
         kind, author_id, credential_id, proposal_id, op_index, corrected, base_reviewed, note, created_at, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        pageId,
        p.revision,
        p.address,
        p.type,
        p.title,
        p.summary,
        p.body,
        p.tags,
        p.status,
        JSON.stringify(
          sources.map((s) =>
            s.entry_id != null
              ? { entryId: s.entry_id }
              : s.title == null
                ? { url: s.url }
                : { url: s.url, title: s.title },
          ),
        ),
        JSON.stringify(links.map((l) => ({ kind: l.kind, to: l.to }))),
        meta.kind,
        ctx.who.accountId,
        ctx.who.credential.id,
        meta.proposalId ?? null,
        it.index ?? null,
        Boolean(it.corrected),
        Boolean(it.baseReviewed),
        note ?? null,
        now,
        meta.kind === 'proposal' ? null : it.op.reason,
      ],
    )
    revised.push({
      ...(it.index === undefined ? {} : { index: it.index }),
      pageId,
      address: String(p.address),
      revision: Number(p.revision),
    })
    touched.add(String(p.address))
  }
  const bump = async (pageId: string, sets: string, values: unknown[]) => {
    await db.query(
      `UPDATE pages SET ${sets}${sets ? ', ' : ''}revision = revision + 1, updated_at = $2 WHERE id = $1`,
      [pageId, now, ...values],
    )
  }
  const setStatus = async (it: ApplyItem, p: Row, status: string, supersededBy: string | null) => {
    await bump(String(p.id), 'status = $3, superseded_by = $4', [status, supersededBy])
    await revise(it, String(p.id))
  }

  for (const { it } of sorted) {
    const o = it.op
    switch (o.op) {
      case 'create': {
        const taken = await db.one(
          'SELECT page_id FROM page_addresses WHERE brain_id = $1 AND address = $2',
          [brainId, o.address],
        )
        if (taken) fail(it, `the address "${o.address}" is taken or reserved.`)
        await checkEntries(it, o.sources)
        const id = newId('pg')
        await db.query(
          `INSERT INTO pages (id, brain_id, address, type, title, summary, body, tags, status, revision, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'current',1,$9,$9)`,
          [id, brainId, o.address, o.type, o.title, o.summary, o.body, o.tags, now],
        )
        await db.query(
          'INSERT INTO page_addresses (brain_id, address, page_id, created_at) VALUES ($1,$2,$3,$4)',
          [brainId, o.address, id, now],
        )
        await addSources(id, o.sources)
        await setMentions({ id, address: o.address }, o.body)
        const supersedes: Row[] = []
        for (const l of o.links) {
          const to = await page(it, l.to)
          if (l.kind === 'supersedes') supersedes.push(to)
          await db.query(
            `INSERT INTO page_links (brain_id, from_page, kind, to_page) VALUES ($1, $2, $3, $4)
             ON CONFLICT (from_page, kind, to_page) WHERE to_page IS NOT NULL DO NOTHING`,
            [brainId, id, l.kind, to.id],
          )
        }
        await revise(it, id)
        for (const t of supersedes) await setStatus(it, t, 'superseded', id)
        break
      }
      case 'edit': {
        const p = await page(it, o.address)
        if (
          o.baseRevision !== undefined &&
          (startRevision.get(String(p.id)) ?? Number(p.revision)) !== o.baseRevision &&
          !it.baseReviewed
        ) {
          fail(
            it,
            `"${p.address}" changed since revision ${o.baseRevision} (it is at ${startRevision.get(String(p.id)) ?? p.revision}).`,
          )
        }
        const sets: string[] = []
        const values: unknown[] = []
        const set = (col: string, v: unknown) => {
          values.push(v)
          sets.push(`${col} = $${values.length + 2}`)
        }
        if (o.type !== undefined) set('type', o.type)
        if (o.title !== undefined) set('title', o.title)
        if (o.summary !== undefined) set('summary', o.summary)
        if (o.body !== undefined) set('body', o.body)
        if (o.tags !== undefined) set('tags', o.tags)
        await bump(String(p.id), sets.join(', '), values)
        if (o.sources !== undefined) {
          await checkEntries(it, o.sources)
          await setSources(String(p.id), o.sources)
        }
        if (o.body !== undefined) await setMentions({ id: String(p.id), address: String(p.address) }, o.body)
        await revise(it, String(p.id))
        break
      }
      case 'move': {
        const p = await page(it, o.address)
        const holder = await db.one(
          'SELECT page_id FROM page_addresses WHERE brain_id = $1 AND address = $2',
          [brainId, o.to],
        )
        if (holder && holder.page_id !== p.id)
          fail(it, `the address "${o.to}" is taken or reserved by another page.`)
        if (!holder) {
          await db.query(
            'INSERT INTO page_addresses (brain_id, address, page_id, created_at) VALUES ($1,$2,$3,$4)',
            [brainId, o.to, p.id, now],
          )
        }
        await bump(String(p.id), 'address = $3', [o.to])
        await revise(it, String(p.id), `moved from "${p.address}"`)
        break
      }
      case 'link': {
        const p = await page(it, o.address)
        const t = await page(it, o.to)
        await addLink(it, p, o.kind, t)
        await bump(String(p.id), '', [])
        await revise(it, String(p.id))
        // "supersedes": this page replaces that one, which becomes superseded (spec B2 «Enlaces»).
        if (o.kind === 'supersedes') await setStatus(it, t, 'superseded', String(p.id))
        break
      }
      case 'unlink': {
        const p = await page(it, o.address)
        const t = await page(it, o.to)
        await db.query('DELETE FROM page_links WHERE from_page = $1 AND kind = $2 AND to_page = $3', [
          p.id,
          o.kind,
          t.id,
        ])
        await bump(String(p.id), '', [])
        await revise(it, String(p.id))
        break
      }
      case 'status': {
        const p = await page(it, o.address)
        const by =
          o.status === 'superseded' && o.supersededBy ? String((await page(it, o.supersededBy)).id) : null
        if (by === p.id) fail(it, 'a page cannot supersede itself.')
        await setStatus(it, p, o.status, by)
        break
      }
      case 'merge': {
        const x = await page(it, o.address)
        const y = await page(it, o.from)
        if (x.id === y.id) fail(it, 'a page cannot be merged into itself.')
        const drop = new Set(o.dropSources.map(sourceKey))
        const ys = await db.query('SELECT entry_id, url, title FROM page_sources WHERE page_id = $1', [y.id])
        await addSources(
          String(x.id),
          ys
            .map(
              (s): Source =>
                s.entry_id != null
                  ? { entryId: String(s.entry_id) }
                  : s.title == null
                    ? { url: String(s.url) }
                    : { url: String(s.url), title: String(s.title) },
            )
            .filter((s) => !drop.has(sourceKey(s))),
        )
        const dropLinks = new Set(o.dropLinks.map((l) => `${l.kind}>${l.to}`))
        // y's typed links now leave from x, but those the operation drops.
        const yOut = await db.query(
          `SELECT l.kind, l.to_page, t.address FROM page_links l JOIN pages t ON t.id = l.to_page
            WHERE l.from_page = $1`,
          [y.id],
        )
        for (const l of yOut) {
          if (l.to_page === x.id || dropLinks.has(`${l.kind}>${l.address}`)) continue
          await db.query(
            `INSERT INTO page_links (brain_id, from_page, kind, to_page) VALUES ($1, $2, $3, $4)
             ON CONFLICT (from_page, kind, to_page) WHERE to_page IS NOT NULL DO NOTHING`,
            [brainId, x.id, l.kind, l.to_page],
          )
        }
        await db.query('DELETE FROM page_links WHERE from_page = $1 AND to_page IS NOT NULL', [y.id])
        // Links that went to y now lead to x.
        await db.query(
          `INSERT INTO page_links (brain_id, from_page, kind, to_page)
           SELECT brain_id, from_page, kind, $2 FROM page_links WHERE to_page = $1 AND from_page <> $2
              AND kind <> 'supersedes'
           ON CONFLICT (from_page, kind, to_page) WHERE to_page IS NOT NULL DO NOTHING`,
          [y.id, x.id],
        )
        await db.query('DELETE FROM page_links WHERE to_page = $1', [y.id])
        // Every address y had now leads to x, so [[y]] mentions resolve to x without touching bodies.
        await db.query('UPDATE page_addresses SET page_id = $2 WHERE page_id = $1', [y.id, x.id])
        await bump(String(x.id), 'body = $3', [o.body])
        await setMentions({ id: String(x.id), address: String(x.address) }, o.body)
        await revise(it, String(x.id), `merged "${y.address}" into it`)
        await setStatus(it, y, 'superseded', String(x.id))
        break
      }
      case 'revert': {
        const p = await page(it, o.address)
        const r = await db.one('SELECT * FROM page_revisions WHERE page_id = $1 AND revision = $2', [
          p.id,
          o.toRevision,
        ])
        if (!r) fail(it, `"${p.address}" has no revision ${o.toRevision}.`)
        const old = r as Row
        if (old.purged_at) fail(it, `revision ${o.toRevision} of "${p.address}" was purged.`)
        await bump(String(p.id), 'type = $3, title = $4, summary = $5, body = $6, tags = $7', [
          old.type,
          old.title,
          old.summary,
          old.body,
          old.tags,
        ])
        // Sources purged since that revision do not come back.
        const was = (old.sources as Source[]) ?? []
        const ids = was.flatMap((s) => ('entryId' in s ? [s.entryId] : []))
        const alive = new Set(
          ids.length === 0
            ? []
            : (
                await db.query(
                  "SELECT id FROM entries WHERE brain_id = $1 AND id = ANY($2) AND state <> 'purged'",
                  [brainId, ids],
                )
              ).map((r) => String(r.id)),
        )
        await setSources(
          String(p.id),
          was.filter((s) => !('entryId' in s) || alive.has(s.entryId)),
        )
        await db.query('DELETE FROM page_links WHERE from_page = $1 AND to_page IS NOT NULL', [p.id])
        for (const l of (old.links as { kind: LinkKind; to: string }[]) ?? []) {
          const t = await db.one(
            'SELECT p.id FROM page_addresses a JOIN pages p ON p.id = a.page_id WHERE a.brain_id = $1 AND a.address = $2',
            [brainId, l.to],
          )
          if (t && t.id !== p.id) {
            await db.query(
              `INSERT INTO page_links (brain_id, from_page, kind, to_page) VALUES ($1, $2, $3, $4)
               ON CONFLICT (from_page, kind, to_page) WHERE to_page IS NOT NULL DO NOTHING`,
              [brainId, p.id, l.kind, t.id],
            )
          }
        }
        await setMentions({ id: String(p.id), address: String(p.address) }, String(old.body))
        await revise(it, String(p.id), `back to revision ${o.toRevision}`)
        break
      }
    }
  }

  const pages = [...touched]
  const logId = newId('wlg')
  await db.query(
    `INSERT INTO wiki_log (id, brain_id, at, actor_id, kind, proposal_id, summary, pages, reason, credential_id,
       key_name, maintenance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      logId,
      brainId,
      now,
      ctx.who.accountId,
      meta.kind,
      meta.proposalId ?? null,
      meta.summary.slice(0, 500),
      pages,
      meta.kind === 'proposal' ? null : (meta.reason ?? null),
      ctx.who.credential.id,
      meta.keyName?.slice(0, 200) ?? null,
      Boolean(meta.maintenance),
    ],
  )
  await emit(db, ctx, {
    brainId,
    kind: 'wiki.changed',
    targetId: meta.proposalId ?? null,
    label: meta.summary,
  })
  return { revised, pages, logId }
}
