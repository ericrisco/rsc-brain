// The one writer of wiki pages (spec B2). An approved proposal, a curator's direct edit and going back
// to a revision all come through here, inside the caller's transaction: every operation applies, or
// the error rolls everything back (CA5). Each change leaves a revision of the page it changed, with
// its sources and typed links as they stood, and the whole call leaves one line in the log.
import { AppError } from '../../core/errors.ts'
import { newId } from '../../core/ids.ts'
import type { Db, Row } from '../../db/db.ts'
import { type Ctx, personInWeb } from '../context.ts'
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

// Undoing a change (spec learning-memory A2, R7; plan §2.5): put one page back as the change found it — its content,
// sources and links out of the revision before, its status, its address and every address row, and the typed links into
// it — or, for a page the change created, retire it and free its address (M7). Internal: never accepted from clients
// (readOp knows no «restore»); only undo.ts builds it.
export type RestoreOp = {
  op: 'restore'
  address: string
  reason: string
  pageId: string
  created: boolean
  revisionBefore: number | null
  addressBefore: string | null
  statusBefore: string | null
  supersededByBefore: string | null
  addressesBefore: string[]
  addressesAdded: string[]
  linksInBefore: { fromPage: string; kind: LinkKind }[]
  // The links into it as the change left them (null for a change recorded before round 2: nothing is taken back). The
  // undo is the exact inverse of that delta, never a guess from the other pages of the change (review round 2, V1–V2).
  linksInAfter: { fromPage: string; kind: LinkKind }[] | null
  // Every page of the change: an address goes back only from one of them (review round 1, U4).
  changePages: string[]
  note: string
}
export type ApplyItem = { op: Op | RestoreOp; index?: number; corrected?: boolean; baseReviewed?: boolean }
export type ApplyMeta = {
  // 'write': a key with the permission wrote it directly (spec v0.6).
  // 'undo': a change of «Review later» undone (spec learning-memory A2).
  kind: 'proposal' | 'direct' | 'revert' | 'write' | 'undo'
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

// What a page was before a call changed it, taken the first time the call locks it (spec learning-memory A2, plan §2.4):
// what an exact undo puts back. A merge moves addresses and incoming links of other pages without a revision there,
// and a revision does not keep the status, so they are kept here. Never the text of a page: that stays in
// page_revisions, where a purge reaches it. `revision` is null for a page the call created.
export type PageBefore = {
  pageId: string
  revision: number | null
  address: string
  status: string | null
  supersededBy: string | null
  addresses: string[]
  linksIn: { fromPage: string; kind: LinkKind }[]
  created: boolean
}

// The order operations apply in: the proposal's own, except that an operation using an address
// another operation brings into being (a page it creates, the new address of a move) goes after it, so
// a link listed before the page it points at still applies. Approval grouping (dependencies) is a
// different question: "edit y" before "merge y into x" must still edit y, then merge.
// The addresses an operation brings into being: the page it creates, or the new address of a move.
function bornOf(o: Op | RestoreOp): string[] {
  return o.op === 'create' ? [o.address] : o.op === 'move' ? [o.to] : []
}

// A cycle is one dependency group: finish its creates and links before any operation consuming it.
// At most 50 operations (WIKI_LIMITS.ops), so transitive closure keeps the grouping small and explicit.
function applyGroups(ops: (Op | RestoreOp)[]): number[][] {
  const born = ops.map(bornOf)
  const after = ops.map((o, i) => {
    // A restore names its page by id: it needs nothing another operation brings into being.
    const mine = new Set(o.op === 'restore' ? [] : uses(o))
    return ops.flatMap((_, j) => (j !== i && (born[j] ?? []).some((a) => mine.has(a)) ? [j] : []))
  })
  const reaches = after.map((deps, i) => new Set([i, ...deps]))
  for (const [pivot, targets] of reaches.entries()) {
    for (const sources of reaches) {
      if (sources.has(pivot)) for (const target of targets) sources.add(target)
    }
  }
  const unseen = new Set(ops.map((_, i) => i))
  const pending: number[][] = []
  for (const i of unseen) {
    const group = [...unseen].filter((j) => reaches[i]?.has(j) && reaches[j]?.has(i))
    pending.push(group)
    for (const j of group) unseen.delete(j)
  }
  // A cycle waits for its last producer, just as an acyclic forward link does. Independent
  // operations between its members keep their turn instead of being jumped by a later create.
  pending.sort((a, b) => Math.max(...a) - Math.max(...b))
  const done = new Set<number>()
  const out: number[][] = []
  while (pending.length) {
    const next = pending.findIndex((g) =>
      g.every((i) => (after[i] ?? []).every((j) => done.has(j) || g.includes(j))),
    )
    const group = pending.splice(next, 1)[0] as number[]
    const remaining = new Set(group)
    const ordered: number[] = []
    while (remaining.size) {
      // A create can defer its links, but a move still needs its source page to exist first.
      const ready =
        [...remaining].find(
          (i) => ops[i]?.op === 'create' || (after[i] ?? []).every((j) => !remaining.has(j)),
        ) ?? ([...remaining][0] as number)
      ordered.push(ready)
      remaining.delete(ready)
      done.add(ready)
    }
    out.push(ordered)
  }
  return out
}

export function applyOrder(ops: Op[]): number[] {
  return applyGroups(ops).flat()
}

export async function applyOps(
  ctx: Ctx,
  db: Db,
  brainId: string,
  items: ApplyItem[],
  meta: ApplyMeta,
): Promise<{ revised: Revised[]; pages: string[]; logId: string; before: PageBefore[] }> {
  // One writer per brain's wiki at a time: approvals, direct edits and reverts queue here.
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`wiki:${brainId}`])
  const now = ctx.clock()
  const revised: Revised[] = []
  const touched = new Set<string>()
  const groups = applyGroups(items.map((x) => x.op)).map((group) =>
    group.map((i) => ({ it: items[i] as ApplyItem })),
  )
  // Each page's revision before this call: an edit's baseRevision is checked against it, not against
  // what earlier operations of the same approval made of the page (a move, then an edit of it).
  const startRevision = new Map<string, number>()
  const before: PageBefore[] = []
  const snapped = new Set<string>()
  const snapshot = async (r: Row) => {
    const id = String(r.id)
    const addresses = await db.query<{ address: string }>(
      'SELECT address FROM page_addresses WHERE page_id = $1 ORDER BY address',
      [id],
    )
    const linksIn = await db.query<{ from_page: string; kind: LinkKind }>(
      'SELECT from_page, kind FROM page_links WHERE to_page = $1 ORDER BY from_page, kind',
      [id],
    )
    before.push({
      pageId: id,
      revision: Number(r.revision),
      address: String(r.address),
      status: String(r.status),
      supersededBy: r.superseded_by == null ? null : String(r.superseded_by),
      addresses: addresses.map((a) => a.address),
      linksIn: linksIn.map((l) => ({ fromPage: l.from_page, kind: l.kind })),
      created: false,
    })
  }
  // Creates that link each other (an index and its pages, which point back with part-of) have no order in
  // which every link finds its page, yet the proposal was accepted because each page "is created here". A
  // create's link to an address its dependency group still brings into being waits for that group,
  // then lands before downstream operations: one more revision of the page it starts from.
  const unborn = new Map<string, number>()
  for (const { it } of groups.flat()) for (const a of bornOf(it.op)) unborn.set(a, (unborn.get(a) ?? 0) + 1)
  const deferred = new Map<string, { it: ApplyItem; links: { kind: LinkKind; to: string }[] }>()

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
    if (r && !snapped.has(String(r.id))) {
      snapped.add(String(r.id))
      await snapshot(r)
    }
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

  for (const group of groups) {
    // A cyclic group's supersedes effects follow create order, whether its links were ready or deferred.
    const supersedes: { it: ApplyItem; from: string; to: string }[] = []
    for (const { it } of group) {
      const o = it.op
      for (const a of bornOf(o)) unborn.set(a, (unborn.get(a) ?? 1) - 1)
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
          snapped.add(id)
          before.push({
            pageId: id,
            revision: null,
            address: o.address,
            status: null,
            supersededBy: null,
            addresses: [],
            linksIn: [],
            created: true,
          })
          await addSources(id, o.sources)
          await setMentions({ id, address: o.address }, o.body)
          for (const l of o.links) {
            if (l.kind === 'supersedes') supersedes.push({ it, from: id, to: l.to })
            if ((unborn.get(l.to) ?? 0) > 0) {
              const waiting = deferred.get(id) ?? { it, links: [] }
              waiting.links.push(l)
              deferred.set(id, waiting)
              continue
            }
            const to = await page(it, l.to)
            await db.query(
              `INSERT INTO page_links (brain_id, from_page, kind, to_page) VALUES ($1, $2, $3, $4)
             ON CONFLICT (from_page, kind, to_page) WHERE to_page IS NOT NULL DO NOTHING`,
              [brainId, id, l.kind, to.id],
            )
          }
          await revise(it, id)
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
          if (o.body !== undefined)
            await setMentions({ id: String(p.id), address: String(p.address) }, o.body)
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
          const ys = await db.query('SELECT entry_id, url, title FROM page_sources WHERE page_id = $1', [
            y.id,
          ])
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
          // Remove excluded links before transferring debates. When the last direction goes, the
          // unlink trigger clears y's mark even if x already had its own contradiction with that page.
          if (o.dropLinks.length)
            await db.query(
              `DELETE FROM page_links l USING pages t WHERE l.from_page = $1 AND l.to_page = t.id
                AND (l.kind, t.address) IN (SELECT * FROM unnest($2::text[], $3::text[]))`,
              [y.id, o.dropLinks.map((l) => l.kind), o.dropLinks.map((l) => l.to)],
            )
          // y's known debates pass to x (not with x itself); the links y loses below take the old ones away.
          await db.query(
            `INSERT INTO wiki_debates (brain_id, page_a, page_b, acknowledged_by, acknowledged_at)
             SELECT brain_id, least($2::text, CASE WHEN page_a = $1 THEN page_b ELSE page_a END),
                    greatest($2::text, CASE WHEN page_a = $1 THEN page_b ELSE page_a END), acknowledged_by, acknowledged_at
               FROM wiki_debates WHERE brain_id = $3 AND (page_a = $1 OR page_b = $1)
                AND CASE WHEN page_a = $1 THEN page_b ELSE page_a END <> $2
             ON CONFLICT DO NOTHING`,
            [y.id, x.id, brainId],
          )
          // y's remaining typed links now leave from x.
          await db.query(
            `INSERT INTO page_links (brain_id, from_page, kind, to_page)
             SELECT brain_id, $2, kind, to_page FROM page_links
              WHERE from_page = $1 AND to_page IS NOT NULL AND to_page <> $2
             ON CONFLICT (from_page, kind, to_page) WHERE to_page IS NOT NULL DO NOTHING`,
            [y.id, x.id],
          )
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
          // Older data may contain a mark without a link. Leave only actual debates on the survivor.
          await db.query(
            `DELETE FROM wiki_debates d WHERE d.brain_id = $2 AND (d.page_a = $1 OR d.page_b = $1)
               AND NOT EXISTS (SELECT 1 FROM page_links l WHERE l.kind = 'contradicts'
                 AND ((l.from_page = d.page_a AND l.to_page = d.page_b) OR (l.from_page = d.page_b AND l.to_page = d.page_a)))`,
            [x.id, brainId],
          )
          await bump(String(x.id), 'body = $3', [o.body])
          await setMentions({ id: String(x.id), address: String(x.address) }, o.body)
          await revise(it, String(x.id), `merged "${y.address}" into it`)
          await setStatus(it, y, 'superseded', String(x.id))
          break
        }
        case 'restore': {
          const p = (await db.one('SELECT * FROM pages WHERE id = $1 AND brain_id = $2 FOR UPDATE', [
            o.pageId,
            brainId,
          ])) as Row | undefined
          if (!p) fail(it, `the page "${o.address}" is gone.`)
          const row = p as Row
          const id = String(row.id)
          if (!startRevision.has(id)) startRevision.set(id, Number(row.revision))
          if (!snapped.has(id)) {
            snapped.add(id)
            await snapshot(row)
          }
          if (o.created) {
            // Created by the change: retired, out of search and context, its links gone and its address free (M7).
            await db.query('DELETE FROM page_links WHERE from_page = $1', [id])
            await db.query('DELETE FROM page_addresses WHERE page_id = $1', [id])
            await bump(id, "status = 'retired', superseded_by = NULL", [])
            await revise(it, id, o.note)
            break
          }
          const old = (await db.one('SELECT * FROM page_revisions WHERE page_id = $1 AND revision = $2', [
            id,
            o.revisionBefore,
          ])) as Row | undefined
          if (!old || old.purged_at)
            fail(it, `revision ${o.revisionBefore} of "${o.address}" is not there to go back to.`)
          const was = old as Row
          // Its address rows: those it had come back to it (a merge gave them to another page); those the change
          // added go.
          for (const a of o.addressesBefore) {
            // Only from a page of the change (a merge): an address another page took since is a conflict undo.ts
            // refused before getting here (review round 1, U4).
            await db.query(
              'UPDATE page_addresses SET page_id = $3 WHERE brain_id = $1 AND address = $2 AND page_id = ANY($4)',
              [brainId, a, id, o.changePages],
            )
            await db.query(
              `INSERT INTO page_addresses (brain_id, address, page_id, created_at) VALUES ($1, $2, $3, $4)
               ON CONFLICT DO NOTHING`,
              [brainId, a, id, now],
            )
          }
          const keep = new Set(o.addressesBefore)
          const drop = o.addressesAdded.filter((a) => !keep.has(a))
          if (drop.length)
            await db.query('DELETE FROM page_addresses WHERE page_id = $1 AND address = ANY($2)', [id, drop])
          await bump(
            id,
            'type = $3, title = $4, summary = $5, body = $6, tags = $7, status = $8, superseded_by = $9, address = $10',
            [
              was.type,
              was.title,
              was.summary,
              was.body,
              was.tags,
              o.statusBefore ?? was.status,
              o.supersededByBefore,
              o.addressBefore ?? row.address,
            ],
          )
          // Sources purged since do not come back.
          const before = (was.sources as Source[]) ?? []
          const ids = before.flatMap((x) => ('entryId' in x ? [x.entryId] : []))
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
            id,
            before.filter((x) => !('entryId' in x) || alive.has(x.entryId)),
          )
          // Its typed links out, as the revision lists them.
          const want: { kind: LinkKind; to: string }[] = []
          for (const l of (was.links as { kind: LinkKind; to: string }[]) ?? []) {
            const t = await db.one(
              'SELECT p.id FROM page_addresses a JOIN pages p ON p.id = a.page_id WHERE a.brain_id = $1 AND a.address = $2',
              [brainId, l.to],
            )
            if (t && t.id !== id) want.push({ kind: l.kind, to: String(t.id) })
          }
          await db.query(
            `DELETE FROM page_links WHERE from_page = $1 AND to_page IS NOT NULL
               AND (kind, to_page) NOT IN (SELECT * FROM unnest($2::text[], $3::text[]))`,
            [id, want.map((l) => l.kind), want.map((l) => l.to)],
          )
          for (const l of want)
            await db.query(
              `INSERT INTO page_links (brain_id, from_page, kind, to_page) VALUES ($1, $2, $3, $4)
               ON CONFLICT (from_page, kind, to_page) WHERE to_page IS NOT NULL DO NOTHING`,
              [brainId, id, l.kind, l.to],
            )
          // The typed links into it (from, kind, to = this page), as the exact inverse of what the change did to them
          // (review round 2): a link the change added goes if it is still there; a link the change took away (a merge
          // moved it to another page, an unlink, a body that dropped it) comes back if it is still missing and its page
          // exists. Any other link into the page — whatever a later write made or took away — is left as it is.
          if (o.linksInAfter) {
            const key = (l: { fromPage: string; kind: string }) => `${l.fromPage} ${l.kind}`
            const before = new Set(o.linksInBefore.filter((l) => l.fromPage !== id).map(key))
            const after = new Set(o.linksInAfter.filter((l) => l.fromPage !== id).map(key))
            for (const l of o.linksInAfter) {
              if (l.fromPage === id || before.has(key(l))) continue
              await db.query('DELETE FROM page_links WHERE from_page = $1 AND kind = $2 AND to_page = $3', [
                l.fromPage,
                l.kind,
                id,
              ])
            }
            for (const l of o.linksInBefore) {
              if (l.fromPage === id || after.has(key(l))) continue
              await db.query(
                `INSERT INTO page_links (brain_id, from_page, kind, to_page)
                 SELECT $1, $2, $3, $4 WHERE EXISTS (SELECT 1 FROM pages WHERE id = $2 AND status <> 'retired')
                 ON CONFLICT (from_page, kind, to_page) WHERE to_page IS NOT NULL DO NOTHING`,
                [brainId, l.fromPage, l.kind, id],
              )
            }
          }
          await setMentions({ id, address: String(o.addressBefore ?? row.address) }, String(was.body))
          await revise(it, id, o.note)
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
          // Only the links the revision does not list go, and only the missing ones come back: a link the page
          // keeps is never deleted (a known debate rides on its contradicts link).
          const want: { kind: LinkKind; to: string }[] = []
          for (const l of (old.links as { kind: LinkKind; to: string }[]) ?? []) {
            const t = await db.one(
              'SELECT p.id FROM page_addresses a JOIN pages p ON p.id = a.page_id WHERE a.brain_id = $1 AND a.address = $2',
              [brainId, l.to],
            )
            if (t && t.id !== p.id) want.push({ kind: l.kind, to: String(t.id) })
          }
          await db.query(
            `DELETE FROM page_links WHERE from_page = $1 AND to_page IS NOT NULL
               AND (kind, to_page) NOT IN (SELECT * FROM unnest($2::text[], $3::text[]))`,
            [p.id, want.map((l) => l.kind), want.map((l) => l.to)],
          )
          for (const l of want) {
            await db.query(
              `INSERT INTO page_links (brain_id, from_page, kind, to_page) VALUES ($1, $2, $3, $4)
               ON CONFLICT (from_page, kind, to_page) WHERE to_page IS NOT NULL DO NOTHING`,
              [brainId, p.id, l.kind, l.to],
            )
          }
          await setMentions({ id: String(p.id), address: String(p.address) }, String(old.body))
          await revise(it, String(p.id), `back to revision ${o.toRevision}`)
          break
        }
      }
    }

    for (const [pageId, { it, links }] of deferred) {
      const from = await db.one('SELECT * FROM pages WHERE id = $1 FOR UPDATE', [pageId])
      if (!from) fail(it, 'the page it creates is gone before its links could be added.')
      for (const l of links) {
        const to = await page(it, l.to)
        await addLink(it, from as Row, l.kind, to)
      }
      await bump(pageId, '', [])
      await revise(it, pageId, 'links to pages created in the same approval')
    }

    for (const effect of supersedes) {
      await setStatus(effect.it, await page(effect.it, effect.to), 'superseded', effect.from)
    }
    deferred.clear()
  }

  // A person in the web saw what they wrote: their revisions are reviewed (spec learning-memory A1, CA-A9).
  if (personInWeb(ctx) && revised.length > 0)
    await db.query('UPDATE pages SET reviewed_revision = revision WHERE id = ANY($1)', [
      [...new Set(revised.map((r) => r.pageId))],
    ])
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
  return { revised, pages, logId, before }
}
