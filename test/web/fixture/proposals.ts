// The proposals of the fixture API (spec B6 «Proposals», B2 «Revisar una propuesta»; PR21): pending ones
// with independent changes (CA2), with changes that need each other, and an old one whose edit was written
// on an older revision of its page (three versions); decided ones in every status. Reviewing, approving
// all or part, and returning answer as the server does: the fingerprint of what was seen, a comment for
// what goes back, dependencies, an old base, a role that may not decide, and 409 when it changed or
// someone decided meanwhile. The wiki pages it shows come from the fixture's wiki. Fictitious content.
import { pageState, type Wiki } from './wiki.ts'

type Answer = { status: number; body: unknown }
type Who = { id: string; name: string }
type Op = { op: string; address: string; reason: string; [k: string]: unknown }
type OpStatus = 'pending' | 'approved' | 'returned'
type Status = 'pending' | 'approved' | 'partially_approved' | 'returned' | 'withdrawn' | 'superseded'

export type FxProposal = {
  id: string
  title: string
  reason: string
  author: Who
  agent: string | null
  status: Status
  old: boolean
  supersedes: string | null
  supersededBy: string | null
  collected: string[]
  comment: string | null
  decidedBy: Who | null
  decidedAt: string | null
  createdAt: string
  // Changes when the proposal changes: the fingerprint is made from it.
  version: number
  ops: Array<{ op: Op; status: OpStatus; dependsOn: number[]; corrected: boolean }>
}
export type Inbox = { brain: string; proposals: FxProposal[] }

const ERIC = { id: 'acc_eric', name: 'Eric' }
const FACTORY = { id: 'acc_factory', name: 'RSC Factory' }
const STATUSES: Status[] = [
  'pending',
  'approved',
  'partially_approved',
  'returned',
  'withdrawn',
  'superseded',
]

const err = (status: number, code: string, message: string, howToProceed: string, extra = {}): Answer => ({
  status,
  body: { error: { code, message, howToProceed, ...extra } },
})
export const NO_PROPOSAL = err(
  404,
  'not_found',
  'No proposal with that id here.',
  'Check the id in the list of proposals of the brain.',
)

const op = (o: Op, dependsOn: number[] = [], status: OpStatus = 'pending') => ({
  op: o,
  status,
  dependsOn,
  corrected: false,
})

function proposal(p: Partial<FxProposal> & Pick<FxProposal, 'id' | 'title' | 'ops'>): FxProposal {
  return {
    reason: 'The journal of October says so.',
    author: ERIC,
    agent: 'Claude Code',
    status: 'pending',
    old: false,
    supersedes: null,
    supersededBy: null,
    collected: [],
    comment: null,
    decidedBy: null,
    decidedAt: null,
    createdAt: '2026-10-28T10:00:00.000Z',
    version: 1,
    ...p,
  }
}

const decided =
  (status: OpStatus) =>
  (o: Op, deps: number[] = []) =>
    op(o, deps, status)

// The inbox of a brain. growth: three pending (as its numbers say) and one of each decided status.
export function freshInbox(brain: string): Inbox {
  if (brain === 'support') {
    return {
      brain,
      proposals: [
        proposal({
          id: 'prp_support1',
          title: 'Refunds: answer within a day',
          reason: 'Three sessions this week say so.',
          ops: [
            op({
              op: 'create',
              address: 'support/refunds',
              type: 'guide',
              title: 'Refunds',
              summary: 'Answer within a day.',
              body: 'Answer every refund request within a day.',
              tags: [],
              sources: [{ entryId: 'ent_fx_intros' }],
              links: [],
              reason: 'What the agents learnt.',
            }),
          ],
        }),
      ],
    }
  }
  if (brain !== 'growth') return { brain, proposals: [] }
  return {
    brain,
    proposals: [
      // Three changes that do not need each other (CA2).
      proposal({
        id: 'prp_growth1',
        title: 'Intros: keep them under 10 seconds',
        reason: 'Five sessions in October measured it: short intros keep viewers.',
        collected: ['ent_fx_30s'],
        ops: [
          op({
            op: 'edit',
            address: 'audience/intros',
            baseRevision: 1,
            summary: 'How to open a video in under ten seconds.',
            body: 'Open with the question, in under ten seconds. Then [[audience/retention]] explains why. Check it each [[guides/weekly-review]].',
            reason: 'The measure of October.',
          }),
          op({
            op: 'create',
            address: 'audience/hooks',
            type: 'topic',
            title: 'Hooks that work',
            summary: 'The first line decides.',
            body: 'Start with the question of the video, before the greeting.\n\nIt lifted retention by a fifth.',
            tags: ['q4'],
            sources: [{ entryId: 'ent_fx_hooks' }],
            links: [],
            reason: 'A decision of the team.',
          }),
          op({
            op: 'status',
            address: 'product/pricing',
            status: 'stale',
            reason: 'The plans changed in October.',
          }),
        ],
      }),
      // Changes that need each other, and one that does not.
      proposal({
        id: 'prp_growth2',
        title: 'Merge the two retention pages',
        reason: 'Retention is told twice.',
        agent: 'Codex',
        ops: [
          op({
            op: 'create',
            address: 'audience/retention-2025',
            type: 'topic',
            title: 'Retention in 2025',
            summary: 'What to measure next year.',
            body: 'Measure the first minute, then the hook.',
            tags: [],
            sources: [{ entryId: 'ent_fx_intros' }],
            links: [],
            reason: 'Next year.',
          }),
          op(
            {
              op: 'link',
              address: 'audience/retention-2025',
              to: 'audience/retention',
              kind: 'depends-on',
              reason: 'It builds on this year.',
            },
            [0],
          ),
          op({ op: 'move', address: 'people/ana', to: 'people/ana-ruiz', reason: 'Her full name.' }),
        ],
      }),
      // Old (more than 30 days), and its edit was written on revision 2 of a page now at 3.
      proposal({
        id: 'prp_growth3',
        title: 'New page: hooks that work',
        reason: 'The hook goes first.',
        author: FACTORY,
        agent: 'RSC Factory',
        old: true,
        supersedes: 'prp_growth8',
        createdAt: '2026-09-20T10:00:00.000Z',
        ops: [
          op({
            op: 'edit',
            address: 'audience/retention',
            baseRevision: 2,
            body: 'Intros under ten seconds keep viewers. The hook goes before the greeting.\n\nSee [[audience/intros]].',
            reason: 'The hook first.',
          }),
          op({
            op: 'create',
            address: 'guides/hooks',
            type: 'guide',
            title: 'Writing hooks',
            summary: 'The first line.',
            body: 'Say the question first.',
            tags: [],
            sources: [{ entryId: 'ent_fx_hooks' }],
            links: [],
            reason: 'A guide.',
          }),
        ],
      }),
      proposal({
        id: 'prp_growth4',
        title: 'A page for the narrator agent',
        status: 'approved',
        decidedBy: ERIC,
        decidedAt: '2026-10-27T10:00:00.000Z',
        createdAt: '2026-10-26T10:00:00.000Z',
        ops: [
          decided('approved')({
            op: 'create',
            address: 'agents/narrator',
            type: 'agent',
            title: 'Narrator',
            summary: 'The agent that drafts voice-overs.',
            body: 'Drafts voice-overs.',
            tags: ['internal'],
            sources: [],
            links: [],
            reason: 'A new agent.',
          }),
        ],
      }),
      proposal({
        id: 'prp_growth5',
        title: 'Pricing and plans',
        status: 'partially_approved',
        decidedBy: ERIC,
        decidedAt: '2026-10-25T10:00:00.000Z',
        createdAt: '2026-10-24T10:00:00.000Z',
        comment: 'Monthly plans are not gone: keep that page as it is.',
        ops: [
          decided('approved')({
            op: 'edit',
            address: 'product/pricing',
            body: 'Two months free.',
            reason: 'r',
          }),
          decided('returned')({
            op: 'status',
            address: 'product/monthly-only',
            status: 'retired',
            reason: 'Gone.',
          }),
        ],
      }),
      proposal({
        id: 'prp_growth6',
        title: 'Retire the consent page',
        status: 'returned',
        decidedBy: ERIC,
        decidedAt: '2026-10-23T10:00:00.000Z',
        createdAt: '2026-10-22T10:00:00.000Z',
        comment: 'Legal needs it for another year.',
        ops: [
          decided('returned')({
            op: 'status',
            address: 'legal/consent-2024',
            status: 'retired',
            reason: 'Old.',
          }),
        ],
      }),
      proposal({
        id: 'prp_growth7',
        title: 'Rename the intros page',
        status: 'withdrawn',
        createdAt: '2026-10-21T10:00:00.000Z',
        ops: [op({ op: 'move', address: 'audience/intros', to: 'audience/openings', reason: 'r' })],
      }),
      proposal({
        id: 'prp_growth8',
        title: 'New page: hooks',
        status: 'superseded',
        supersededBy: 'prp_growth3',
        author: FACTORY,
        agent: 'RSC Factory',
        createdAt: '2026-09-19T10:00:00.000Z',
        ops: [op({ op: 'create', address: 'guides/hooks', reason: 'r' })],
      }),
    ],
  }
}

// Many pending proposals, for the "much data" state of the list (it goes by pages).
export function bigInbox(brain: string): Inbox {
  return {
    brain,
    proposals: Array.from({ length: 120 }, (_, i) =>
      proposal({
        id: `prp_many${String(i + 1).padStart(3, '0')}`,
        title: `Proposal number ${i + 1}`,
        createdAt: new Date(Date.UTC(2026, 9, 28, 10, 0, 0) - i * 60_000).toISOString(),
        ops: [op({ op: 'status', address: 'product/pricing', status: 'stale', reason: 'r' })],
      }),
    ),
  }
}

const fingerprintOf = (p: FxProposal) => `fp_${p.id}_${p.version}`

const plain = (p: FxProposal) => ({
  id: p.id,
  brainId: 'brn_growth',
  title: p.title,
  reason: p.reason,
  authorId: p.author.id,
  authorName: p.author.name,
  agent: p.agent,
  status: p.status,
  old: p.status === 'pending' && p.old,
  supersedes: p.supersedes,
  supersededBy: p.supersededBy,
  collected: p.collected,
  comment: p.comment,
  decidedBy: p.decidedBy?.id ?? null,
  decidedByName: p.decidedBy?.name ?? null,
  decidedAt: p.decidedAt,
  lastError: null,
  createdAt: p.createdAt,
  purged: false,
})

export function listOf(inbox: Inbox, query: URLSearchParams, empty: boolean): Answer {
  const status = query.get('status') ?? 'pending'
  if (status !== 'all' && !STATUSES.includes(status as Status)) {
    return err(400, 'invalid_request', `"status" is one of: ${STATUSES.join(', ')}, all.`, 'Fix "status".')
  }
  const limit = Math.min(200, Math.max(1, Number(query.get('limit') ?? 50) || 50))
  const all = empty ? [] : inbox.proposals
  const oldest = query.get('order') === 'oldest'
  const matching = all
    .filter((p) => status === 'all' || p.status === status)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0) * (oldest ? -1 : 1))
  const cursor = query.get('cursor')
  const from = cursor ? Number(cursor) : 0
  const page = matching.slice(from, from + limit)
  return {
    status: 200,
    body: {
      items: page.map((p) => ({ ...plain(p), opCount: p.ops.length })),
      total: matching.length,
      next: from + limit < matching.length ? String(from + limit) : null,
      ...(cursor
        ? {}
        : {
            counts: Object.fromEntries(STATUSES.map((s) => [s, all.filter((p) => p.status === s).length])),
          }),
    },
  }
}

function afterOf(o: Op, before: ReturnType<typeof pageState>) {
  const b = before ?? {}
  switch (o.op) {
    case 'create':
      return {
        address: o.address,
        type: o.type,
        title: o.title,
        summary: o.summary,
        body: o.body,
        tags: o.tags ?? [],
        status: 'current',
        sources: o.sources ?? [],
        links: o.links ?? [],
        mentions: [],
      }
    case 'edit':
      return {
        ...b,
        ...Object.fromEntries(
          ['type', 'title', 'summary', 'body', 'tags', 'sources'].filter((k) => k in o).map((k) => [k, o[k]]),
        ),
      }
    case 'move':
      return { ...b, address: o.to }
    case 'link':
      return { ...b, links: [...(before?.links ?? []), { kind: o.kind, to: o.to }] }
    case 'status':
      return { ...b, status: o.status }
    default:
      return { ...b }
  }
}

export function reviewOf(inbox: Inbox, p: FxProposal, wiki: Wiki, canDecide: boolean): Answer {
  const ops = p.ops.map((x, index) => {
    const before = pageState(wiki, x.op.address)
    const after = afterOf(x.op, before)
    const base = typeof x.op.baseRevision === 'number' ? x.op.baseRevision : undefined
    const stale =
      x.status === 'pending' && x.op.op === 'edit' && before && base !== undefined && base < before.revision
        ? { base: pageState(wiki, x.op.address, base), current: before, proposed: after }
        : null
    return {
      index,
      op: x.op,
      status: x.status,
      corrected: x.corrected,
      before,
      after,
      dependsOn: x.dependsOn,
      stale,
      warnings:
        p.status === 'pending' && x.op.op === 'status' && x.op.address === 'product/pricing'
          ? [{ op: index, code: 'linked_from', message: '2 pages link to this page.' }]
          : [],
    }
  })
  void inbox
  return {
    status: 200,
    body: { proposal: plain(p), fingerprint: fingerprintOf(p), ops, warnings: [], canDecide },
  }
}

const FORBIDDEN = err(
  403,
  'forbidden',
  'This needs the curator role in the brain; you are a contributor.',
  'Ask a curator of the brain (Eric) for the curator role.',
)

function stillAsSeen(p: FxProposal, fingerprint: unknown, review: () => Answer): Answer | null {
  if (p.status === 'superseded')
    return err(
      409,
      'proposal_changed',
      'Its author replaced this proposal; nothing was applied.',
      'Review the new version (in "current").',
      {
        current: { supersededBy: p.supersededBy },
      },
    )
  if (p.status !== 'pending') {
    return err(
      409,
      'already_decided',
      p.decidedBy
        ? `Already ${p.status.replace('_', ' ')} by ${p.decidedBy.name} on ${p.decidedAt}.`
        : `This proposal is ${p.status}.`,
      'Nothing to do; open the brain log to see what changed.',
      { current: { status: p.status, decidedBy: p.decidedBy?.id ?? null, decidedAt: p.decidedAt } },
    )
  }
  if (fingerprint !== fingerprintOf(p))
    return err(
      409,
      'proposal_changed',
      'The proposal changed while you were looking at it; nothing was applied.',
      'Review it again (the new version is in "current").',
      { current: (review().body as Record<string, unknown>) ?? null },
    )
  return null
}

export type Decided = { answer: Answer; event?: { status: Status; who: Who } }

const opsOut = (p: FxProposal) =>
  p.ops.map((x, index) => ({
    index,
    op: x.op,
    status: x.status,
    correctedBy: x.corrected ? ERIC.id : null,
    baseReviewedBy: null,
    appliedPage: null,
    appliedRevision: null,
  }))

const indices = (v: unknown) =>
  Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0)
    ? (v as number[])
    : v === undefined
      ? undefined
      : null

export function approve(
  p: FxProposal,
  wiki: Wiki,
  who: Who,
  canDecide: boolean,
  body: Record<string, unknown>,
  review: () => Answer,
  now: string,
): Decided {
  if (!canDecide) return { answer: FORBIDDEN }
  if (typeof body.fingerprint !== 'string' || !body.fingerprint)
    return {
      answer: err(
        400,
        'invalid_request',
        '"fingerprint" is required.',
        'Send the fingerprint of the review.',
      ),
    }
  const changed = stillAsSeen(p, body.fingerprint, review)
  if (changed) return { answer: changed }
  const all = p.ops.map((_, i) => i)
  const asked = indices(body.approve)
  const reviewed = indices(body.baseReviewed)
  if (asked === null || reviewed === null)
    return {
      answer: err(
        400,
        'invalid_request',
        '"approve" is a list of operation numbers.',
        'Send "approve" as [0, 2, …].',
      ),
    }
  const chosen = [...new Set(asked ?? all)].sort((a, b) => a - b)
  if (chosen.length === 0)
    return {
      answer: err(
        400,
        'invalid_request',
        'Approve at least one operation.',
        'To approve none, return the proposal.',
      ),
    }
  if (chosen.some((i) => !all.includes(i)))
    return {
      answer: err(
        400,
        'invalid_request',
        'The proposal has no such operation.',
        `Its operations are 0 to ${all.length - 1}.`,
      ),
    }
  const rest = all.filter((i) => !chosen.includes(i))
  const comment = typeof body.comment === 'string' ? body.comment.trim() : ''
  if (rest.length > 0 && !comment)
    return {
      answer: err(
        400,
        'invalid_request',
        'Approving part of a proposal returns the rest, and that needs a comment.',
        'Write in "comment" why the rest goes back.',
      ),
    }
  const missing = chosen.flatMap((i) => {
    const needs = (p.ops[i]?.dependsOn ?? []).filter((j) => !chosen.includes(j))
    return needs.length ? [{ op: i, needs, message: `${i} needs ${needs.join(', ')}` }] : []
  })
  if (missing.length)
    return {
      answer: err(
        400,
        'missing_dependencies',
        `Some operations cannot be approved without others: ${missing.map((m) => m.message).join('; ')}.`,
        'Approve them together, or leave them all out.',
        { problems: missing },
      ),
    }
  // A correction is the fields the person edited and the revision they saw, laid over the operation, as
  // the server does; an edit's base check then runs on the revision the correction was written on.
  const raw = (body.corrections ?? {}) as Record<string, Record<string, unknown>>
  const corrected = new Map<number, Op>()
  for (const [k, c] of Object.entries(raw)) {
    const x = p.ops[Number(k)]
    const allowed =
      x?.op.op === 'edit'
        ? ['title', 'summary', 'body', 'revision']
        : x?.op.op === 'create'
          ? ['title', 'summary', 'body']
          : x?.op.op === 'merge'
            ? ['body']
            : []
    const bad = !x || !c || typeof c !== 'object' || Object.keys(c).some((key) => !allowed.includes(key))
    if (bad)
      return {
        answer: err(
          400,
          'invalid_request',
          'A correction has problems; nothing was applied.',
          'Fix each one listed in "problems".',
          {
            problems: [
              { op: Number(k), message: 'A correction changes only the title, the summary or the text.' },
            ],
          },
        ),
      }
    const { revision, ...fields } = c
    corrected.set(Number(k), {
      ...x.op,
      ...fields,
      ...(typeof revision === 'number' ? { baseRevision: revision } : {}),
    } as Op)
  }
  for (const i of chosen) {
    const o = corrected.get(i) ?? (p.ops[i]?.op as Op)
    const before = pageState(wiki, o.address)
    const base = typeof o.baseRevision === 'number' ? o.baseRevision : undefined
    if (
      o.op === 'edit' &&
      before &&
      base !== undefined &&
      base !== before.revision &&
      !(reviewed ?? []).includes(i)
    ) {
      return {
        answer: err(
          409,
          'stale_base',
          `Operation ${i}: "${o.address}" changed since revision ${base} (it is at ${before.revision}).`,
          'Correct the operation, mark it "base reviewed" if the change does not matter, or return it.',
          { problems: [{ op: i, base, current: before.revision }] },
        ),
      }
    }
  }
  const applied: Array<{ index: number; pageId: string; address: string; revision: number }> = []
  p.ops.forEach((x, i) => {
    const ok = chosen.includes(i)
    x.status = ok ? 'approved' : 'returned'
    const c = corrected.get(i)
    if (ok && c) {
      x.op = c
      x.corrected = true
    }
    if (ok) {
      const before = pageState(wiki, x.op.address)
      applied.push({
        index: i,
        pageId: before?.pageId ?? `pg_new_${i}`,
        address: x.op.op === 'move' ? String(x.op.to) : x.op.address,
        revision: (before?.revision ?? 0) + 1,
      })
    }
  })
  p.status = rest.length ? 'partially_approved' : 'approved'
  p.decidedBy = who
  p.decidedAt = now
  p.comment = comment || null
  return {
    answer: { status: 200, body: { proposal: plain(p), ops: opsOut(p), applied } },
    event: { status: p.status, who },
  }
}

export function giveBack(
  p: FxProposal,
  who: Who,
  canDecide: boolean,
  body: Record<string, unknown>,
  review: () => Answer,
  now: string,
): Decided {
  if (!canDecide) return { answer: FORBIDDEN }
  const comment = typeof body.comment === 'string' ? body.comment.trim() : ''
  if (typeof body.fingerprint !== 'string' || !comment)
    return { answer: err(400, 'invalid_request', '"comment" is required.', 'Say why it goes back.') }
  const changed = stillAsSeen(p, body.fingerprint, review)
  if (changed) return { answer: changed }
  for (const x of p.ops) x.status = 'returned'
  p.status = 'returned'
  p.decidedBy = who
  p.decidedAt = now
  p.comment = comment
  return {
    answer: { status: 200, body: { proposal: plain(p), ops: opsOut(p), applied: [] } },
    event: { status: 'returned', who },
  }
}

// Another curator decides meanwhile (the live notice «approved by Eva just now»).
export function decideBehind(p: FxProposal, who: Who, status: Status, now: string): void {
  p.status = status
  p.decidedBy = who
  p.decidedAt = now
  for (const x of p.ops) x.status = status === 'returned' ? 'returned' : 'approved'
}

// Its author sends a new version meanwhile (the fingerprint changes).
export function changeBehind(p: FxProposal): void {
  p.version += 1
  p.reason = `${p.reason} (revised)`
}
