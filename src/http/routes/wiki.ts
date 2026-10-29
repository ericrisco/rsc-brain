// The wiki for agents (spec B2): read pages, the map, the decisions, the log and the guide; ask for
// the compile pack; send, read, list and withdraw proposals. Deciding is in the web only.
import { invalid } from '../../core/errors.ts'
import { limitOf } from '../../domain/listing.ts'
import { track, trackPageRead } from '../../domain/trail.ts'
import { compilePack, getGuide, PACK } from '../../domain/wiki/compile.ts'
import { wikiHealth } from '../../domain/wiki/health.ts'
import {
  getPage,
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
import { compact, obj, oneOf, reqStr, str } from '../input.ts'
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

export const wikiRoutes: Route[] = [
  route('GET /v1/brains/:slug/wiki/map', async (r) => ({
    body: await wikiMap(ctxOf(r), r.params.slug as string),
  })),
  route('GET /v1/brains/:slug/wiki/decisions', async (r) => ({
    body: { decisions: await wikiDecisions(ctxOf(r), r.params.slug as string) },
  })),
  route('GET /v1/brains/:slug/wiki/log', async (r) => ({
    body: await wikiLog(
      ctxOf(r),
      r.params.slug as string,
      compact({ cursor: q(r.query.get('cursor')), limit: limitOf(r.query.get('limit')) }),
    ),
  })),
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
    const ctx = ctxOf(r)
    const reading = await getPage(ctx, slug, address)
    await track(ctx.root ?? ctx.db, ctx, {
      brainId: reading.page.brainId,
      kind: 'read',
      resultIds: [reading.page.id],
    })
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
      }),
    )
    return { status: 201, body: out }
  }),
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
      }),
    ),
  })),
  route('GET /v1/proposals/:id', async (r) => ({ body: await getProposal(ctxOf(r), r.params.id as string) })),
  route('POST /v1/proposals/:id/withdraw', async (r) => ({
    body: { proposal: await withdrawProposal(ctxOf(r), r.params.id as string) },
  })),
]
