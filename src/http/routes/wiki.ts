// The wiki for agents (spec B2): read pages, the map, the decisions, the log and the guide; ask for
// the compile pack; send, read, list and withdraw proposals. Deciding is in the web only.
import { invalid } from '../../core/errors.ts'
import { limitOf } from '../../domain/listing.ts'
import { track, trackPageRead } from '../../domain/trail.ts'
import { compilePack, getGuide, PACK } from '../../domain/wiki/compile.ts'
import { wikiGraph } from '../../domain/wiki/graph.ts'
import { wikiHealth } from '../../domain/wiki/health.ts'
import {
  getPage,
  historyOf,
  listPages,
  pageHistory,
  pageRevision,
  wikiDecisions,
  wikiLog,
  wikiMap,
} from '../../domain/wiki/pages.ts'
import {
  getProposal,
  listProposals,
  type ProposalStatus,
  submitProposal,
  withdrawProposal,
} from '../../domain/wiki/proposals.ts'
import { checkWiki, writeWiki } from '../../domain/wiki/write.ts'
import { grantWriter, listWriters, revokeWriter } from '../../domain/wiki/writers.ts'
import { MAX_REPLY_CHARS } from '../bounds.ts'
import { bool, compact, obj, oneOf, reqStr, str } from '../input.ts'
import { type Route, route } from '../router.ts'
import { ctxOf } from './brains.ts'

const q = (v: string | null) => (v === null || v === '' ? undefined : v)

const STATUSES = [
  'pending',
  'approved',
  'partially_approved',
  'returned',
  'withdrawn',
  'superseded',
  'all',
] as const

function whole(v: string | null, name: string, min: number, max: number): number | undefined {
  if (v === null || v === '') return undefined
  const n = Number(v)
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw invalid(`"${name}" must be a whole number from ${min} to ${max}.`, `Fix "${name}".`)
  }
  return n
}

// "loose=1": the pages gathered at a level (no deeper part of the address); anything else is a mistake.
function looseOf(v: string | null): true | undefined {
  if (v === null) return undefined
  if (v !== '1')
    throw invalid('"loose" is "1" or left out.', 'Send loose=1 to open the pages gathered at a level.')
  return true
}

export const wikiRoutes: Route[] = [
  route('GET /v1/brains/:slug/wiki/map', async (r) => {
    const status = q(r.query.get('status'))
    if (status !== undefined && status !== 'all')
      throw invalid('"status" is "all", or left out for current pages only.', 'Fix "status".')
    return { body: await wikiMap(ctxOf(r), r.params.slug as string, { all: status === 'all' }) }
  }),
  route('GET /v1/brains/:slug/wiki/decisions', async (r) => ({
    body: { decisions: await wikiDecisions(ctxOf(r), r.params.slug as string) },
  })),
  route('GET /v1/brains/:slug/wiki/log', async (r) => ({
    body: await wikiLog(
      ctxOf(r),
      r.params.slug as string,
      compact({
        cursor: q(r.query.get('cursor')),
        limit: limitOf(r.query.get('limit')),
        kind: q(r.query.get('kind')),
        page: q(r.query.get('page')),
      }),
    ),
  })),
  // The pages by pages, filtered and sorted (plan §3.5 G9): the list beside the graph.
  route('GET /v1/brains/:slug/wiki/pages', async (r) => ({
    body: await listPages(
      ctxOf(r),
      r.params.slug as string,
      compact({
        q: q(r.query.get('q')),
        prefix: q(r.query.get('prefix')),
        loose: looseOf(r.query.get('loose')),
        type: q(r.query.get('type')),
        status: q(r.query.get('status')),
        tag: q(r.query.get('tag')),
        linkKind: q(r.query.get('linkKind')),
        sort: q(r.query.get('sort')),
        cursor: q(r.query.get('cursor')),
        limit: limitOf(r.query.get('limit')),
      }),
    ),
  })),
  // The graph, whole or one group (plan §3.5 G10).
  route('GET /v1/brains/:slug/wiki/graph', async (r) => {
    // The graph takes the list's filters only; anything else (a sort, a cursor) is a mistake worth saying.
    for (const k of r.query.keys())
      if (!['prefix', 'loose', 'q', 'type', 'status', 'tag', 'linkKind'].includes(k))
        throw invalid(
          `"${k}" is not a parameter of the graph.`,
          'Use prefix, loose, q, type, status, tag or linkKind.',
        )
    const loose = looseOf(r.query.get('loose'))
    return {
      body: await wikiGraph(
        ctxOf(r),
        r.params.slug as string,
        compact({
          prefix: q(r.query.get('prefix')),
          loose,
          q: q(r.query.get('q')),
          type: q(r.query.get('type')),
          status: q(r.query.get('status')),
          tag: q(r.query.get('tag')),
          linkKind: q(r.query.get('linkKind')),
          maxChars: MAX_REPLY_CHARS,
        }),
      ),
      compress: true,
    }
  }),
  route('GET /v1/brains/:slug/wiki/health', async (r) => ({
    body: await wikiHealth(ctxOf(r), r.params.slug as string),
  })),
  route('GET /v1/brains/:slug/wiki/guide', async (r) => ({
    body: await getGuide(ctxOf(r), r.params.slug as string),
  })),
  route('GET /v1/brains/:slug/wiki/compile', async (r) => ({
    body: await compilePack(
      ctxOf(r),
      r.params.slug as string,
      compact({ maxChars: whole(r.query.get('maxChars'), 'maxChars', PACK.min, PACK.max) }),
    ),
  })),
  route('GET /v1/brains/:slug/pages/*address', async (r) => {
    const slug = r.params.slug as string
    const address = r.params.address as string
    const rev = whole(r.query.get('revision'), 'revision', 1, 1_000_000)
    // Every read of a page joins the trail («who read this page», spec B3).
    if (rev !== undefined) {
      const revision = await pageRevision(ctxOf(r), slug, address, rev)
      await trackPageRead(ctxOf(r), slug, address)
      return { body: { revision } }
    }
    const compare = r.query.get('compare')
    if (compare !== null) {
      const parts = compare.split(',')
      const [a, b] = parts.map((x) => whole(x, 'compare', 1, 1_000_000))
      if (parts.length !== 2 || a === undefined || b === undefined)
        throw invalid('"compare" is two revisions, e.g. 3,5.', 'Fix "compare".')
      const body = {
        a: await pageRevision(ctxOf(r), slug, address, a),
        b: await pageRevision(ctxOf(r), slug, address, b),
      }
      await trackPageRead(ctxOf(r), slug, address)
      return { body }
    }
    if (r.query.get('history') === '1') {
      const history = await pageHistory(ctxOf(r), slug, address)
      await trackPageRead(ctxOf(r), slug, address)
      return { body: { history } }
    }
    // The page and its history in one read (the web shows both on one visit: one read, not two).
    const include = q(r.query.get('include'))
    if (include !== undefined && include !== 'history')
      throw invalid('"include" is "history", or left out.', 'Fix "include".')
    const ctx = ctxOf(r)
    const reading = await getPage(ctx, slug, address)
    await track(ctx.root ?? ctx.db, ctx, {
      brainId: reading.page.brainId,
      kind: 'read',
      resultIds: [reading.page.id],
      label: reading.page.address,
    })
    if (include === 'history')
      return { body: { ...reading, history: await historyOf(ctx.db, reading.page.id) } }
    return { body: reading }
  }),
  route('POST /v1/brains/:slug/proposals', async (r) => {
    const b = obj(r.body)
    const out = await submitProposal(
      ctxOf(r),
      r.params.slug as string,
      compact({
        title: reqStr(b, 'title'),
        reason: str(b, 'reason'),
        ops: b.ops,
        collected: b.collected,
        supersedes: str(b, 'supersedes', { max: 40 }),
        agent: str(b, 'agent'),
        maintenance: bool(b, 'maintenance'),
      }),
    )
    return { status: 201, body: out }
  }),
  // A key a curator let write to the wiki sends the operations of a proposal; they apply at once (spec v0.6).
  route('POST /v1/brains/:slug/wiki/write', async (r) => {
    const b = obj(r.body)
    const out = await writeWiki(
      ctxOf(r),
      r.params.slug as string,
      compact({
        title: reqStr(b, 'title'),
        reason: str(b, 'reason'),
        ops: b.ops,
        collected: b.collected,
        agent: str(b, 'agent'),
        maintenance: bool(b, 'maintenance'),
        requestKey: str(b, 'requestKey'),
      }),
    )
    return { status: 201, body: out }
  }),
  // The same body as a proposal: what would block it, and what it would leave incoherent; nothing is written, so
  // it keeps answering during maintenance (what it tries is undone).
  {
    ...route('POST /v1/brains/:slug/wiki/check', async (r) => {
      const b = obj(r.body)
      return {
        body: await checkWiki(
          ctxOf(r),
          r.params.slug as string,
          compact({
            title: reqStr(b, 'title'),
            reason: str(b, 'reason'),
            ops: b.ops,
            collected: b.collected,
          }),
        ),
      }
    }),
    maintenance: 'reads',
  },
  route('GET /v1/brains/:slug/proposals', async (r) => ({
    body: await listProposals(
      ctxOf(r),
      r.params.slug as string,
      compact({
        status: oneOf({ status: q(r.query.get('status')) }, 'status', STATUSES) as
          | ProposalStatus
          | 'all'
          | undefined,
        cursor: q(r.query.get('cursor')),
        limit: limitOf(r.query.get('limit')),
        mine: r.query.get('mine') === '1' || r.query.get('mine') === 'true',
        order: oneOf({ order: q(r.query.get('order')) }, 'order', ['newest', 'oldest']) as
          | 'newest'
          | 'oldest'
          | undefined,
      }),
    ),
  })),
  // The keys that write to the wiki directly (spec v0.6): its curators list them, give it in the web, take it back.
  route('GET /v1/brains/:slug/wiki/writers', async (r) => ({
    body: { writers: await listWriters(ctxOf(r), r.params.slug as string) },
  })),
  route('PUT /v1/brains/:slug/wiki/writers/:keyId', async (r) => ({
    body: { writer: await grantWriter(ctxOf(r), r.params.slug as string, r.params.keyId as string) },
  })),
  route('DELETE /v1/brains/:slug/wiki/writers/:keyId', async (r) => {
    await revokeWriter(ctxOf(r), r.params.slug as string, r.params.keyId as string)
    return { body: { removed: r.params.keyId } }
  }),
  route('GET /v1/proposals/:id', async (r) => ({ body: await getProposal(ctxOf(r), r.params.id as string) })),
  route('POST /v1/proposals/:id/withdraw', async (r) => ({
    body: { proposal: await withdrawProposal(ctxOf(r), r.params.id as string) },
  })),
]
