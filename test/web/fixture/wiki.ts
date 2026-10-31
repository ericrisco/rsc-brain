// The wiki of the fixture API (spec B6 «Wiki», PR19): a small hand-made wiki per brain, with every kind of
// page, link, status and source the screens show, its history, who read it, and edits by hand as the
// server makes them (a new revision, a log line, 409 page_changed with the current version). The 300 pages
// of the seeded generator join the map and the list in the "much-data" state. Fictitious content.
import type { GenPage } from '../../../web/test/data/generate.ts'

const AT = '2026-10-29T10:00:00.000Z'

type Src = { entryId: string } | { url: string; title?: string }
type Typed = { kind: string; to: string }
type Rev = {
  revision: number
  address: string
  type: string
  title: string
  summary: string
  body: string
  tags: string[]
  status: string
  sources: Src[]
  links: Typed[]
  kind: 'proposal' | 'direct' | 'revert'
  change: 'created' | 'edited' | 'linked' | 'status' | 'moved' | 'restored'
  restoredFrom: number | null
  reason: string | null
  authorId: string
  authorName: string
  proposalId: string | null
  createdAt: string
}
type FxPage = {
  id: string
  addresses: string[]
  supersededBy: string | null
  revs: Rev[]
  createdAt: string
}
type Line = {
  id: string
  at: string
  actorId: string
  actorName: string
  kind: 'proposal' | 'direct' | 'revert' | 'purge'
  proposalId: string | null
  summary: string
  reason: string | null
  pages: string[]
}
export type PageCorrection = {
  id: string
  title: string
  appliesTo: string | null
  author: Who
  createdAt: string
}
// corrections: the corrections in force about a page by its addresses (from the brain's journal).
export type Wiki = {
  pages: FxPage[]
  log: Line[]
  seq: number
  corrections?: (addresses: string[]) => PageCorrection[]
}
export type Who = { id: string; name: string }

export const ENTRIES: Record<string, { title: string; content: string; type: string; state: string }> = {
  ent_fx_intros: {
    title: 'Short intros keep viewers',
    content: 'Intros under ten seconds kept 70% of viewers past the first minute in October.',
    type: 'learning',
    state: 'active',
  },
  ent_fx_hooks: {
    title: 'The hook goes first',
    content: 'Starting with the question of the video, before the greeting, lifted retention by a fifth.',
    type: 'decision',
    state: 'active',
  },
  ent_fx_gone: { title: '', content: '', type: 'note', state: 'forgotten' },
}

const RETENTION_BODY = (n: number) =>
  [
    '## What keeps viewers',
    '',
    n === 1
      ? 'Long intros lose viewers.'
      : 'Intros under ten seconds keep viewers past the first minute. Long intros lose a third of them before the hook.',
    '',
    '- Start with the question the video answers.',
    '- Show the result before the steps.',
    n >= 3 ? '- Cut the greeting.' : '',
    '',
    'See [[audience/intros]] for how to write one, and [[audience/old-intros]] for what we did before.',
    'Still to write: [[drafts/hooks-that-work]]. Kept for history: [[legal/consent-2024]].',
    '',
    'The October numbers are in the [retention report](https://example.test/reports/october).',
  ]
    .filter((l, i, all) => l !== '' || all[i - 1] !== '')
    .join('\n')

function page(
  id: string,
  address: string,
  type: string,
  title: string,
  summary: string,
  o: {
    body?: string
    tags?: string[]
    status?: string
    sources?: Src[]
    links?: Typed[]
    supersededBy?: string
    bodies?: string[]
  } = {},
): FxPage {
  const bodies = o.bodies ?? [o.body ?? `${summary}`]
  const revs = bodies.map(
    (body, i): Rev => ({
      revision: i + 1,
      address,
      type,
      title,
      summary,
      body,
      tags: o.tags ?? [],
      status: i === bodies.length - 1 ? (o.status ?? 'current') : 'current',
      sources: o.sources ?? [],
      links: o.links ?? [],
      kind: i === 0 ? 'proposal' : 'direct',
      change: i === 0 ? 'created' : 'edited',
      restoredFrom: null,
      reason: i === 0 ? `What the journal says about ${title.toLowerCase()}.` : 'Tightened the wording.',
      authorId: i % 2 ? 'acc_ana' : 'acc_eric',
      authorName: i % 2 ? 'Ana' : 'Eric',
      proposalId: i === 0 ? `prp_fx_${id}` : null,
      createdAt: `2026-10-${String(20 + i).padStart(2, '0')}T10:00:00.000Z`,
    }),
  )
  return { id, addresses: [address], supersededBy: o.supersededBy ?? null, revs, createdAt: AT }
}

export function freshWiki(): Wiki {
  const pages = [
    page('pg_retention', 'audience/retention', 'topic', 'Retention', 'What keeps viewers watching.', {
      bodies: [RETENTION_BODY(1), RETENTION_BODY(2), RETENTION_BODY(3)],
      tags: ['metric', 'q4'],
      sources: [
        { entryId: 'ent_fx_intros' },
        { entryId: 'ent_fx_hooks' },
        { entryId: 'ent_fx_gone' },
        { url: 'https://example.test/reports/october', title: 'October retention report' },
      ],
      links: [
        { kind: 'related', to: 'audience/intros' },
        { kind: 'depends-on', to: 'product/pricing' },
      ],
    }),
    page('pg_intros', 'audience/intros', 'guide', 'Writing intros', 'How to open a video in ten seconds.', {
      body: 'Open with the question. Then [[audience/retention]] explains why. Check it each [[guides/weekly-review]].',
      tags: ['q4'],
      sources: [{ entryId: 'ent_fx_intros' }],
    }),
    page('pg_old', 'audience/old-intros', 'topic', 'Old intros', 'What we did before October.', {
      status: 'superseded',
      supersededBy: 'pg_intros',
    }),
    page('pg_consent', 'legal/consent-2024', 'decision', 'Consent in 2024', 'How we asked for consent.', {
      status: 'retired',
    }),
    page('pg_pricing', 'product/pricing', 'decision', 'Annual plans', 'Annual plans get two months free.', {
      body: 'We give two months free on annual plans. It contradicts [[product/monthly-only]].',
      tags: ['q4'],
      links: [{ kind: 'contradicts', to: 'product/monthly-only' }],
    }),
    page('pg_monthly', 'product/monthly-only', 'decision', 'Monthly only', 'We sold monthly plans only.', {
      status: 'superseded',
      supersededBy: 'pg_pricing',
    }),
    page('pg_ana', 'people/ana', 'entity', 'Ana', 'Runs the channel’s scripts.'),
    page('pg_narrator', 'agents/narrator', 'agent', 'Narrator', 'The agent that drafts voice-overs.', {
      tags: ['internal'],
    }),
    page('pg_review', 'guides/weekly-review', 'guide', 'Weekly review', 'How we review the week.', {
      status: 'stale',
    }),
    page('pg_report', 'sources/retention-report', 'source', 'October report', 'The October numbers.'),
    // What an agent might write that must never run in the web (plan risk 5).
    page('pg_raw', 'notes/raw-html', 'topic', 'Raw HTML', 'A body with HTML and a script link.', {
      body: [
        'Before <script>window.__pwned = 1</script> after.',
        '',
        '<img src="x" onerror="window.__pwned = 2">',
        '',
        '[click me](javascript:window.__pwned=3) and [ok](https://example.test/fine).',
        '',
        '![a chart](https://example.test/chart.png)',
      ].join('\n'),
    }),
    page('pg_overview', 'overview/audience', 'overview', 'Audience', 'Where to start about the audience.', {
      body: 'Start with [[audience/retention]].',
    }),
  ]
  const log: Line[] = pages.flatMap((p) =>
    p.revs.map((r) => ({
      id: `log_${p.id}_${r.revision}`,
      at: r.createdAt,
      actorId: r.authorId,
      actorName: r.authorName,
      kind: r.kind,
      proposalId: r.proposalId,
      summary: r.kind === 'proposal' ? `Approved: ${r.title}` : `Direct edit: ${r.address}`,
      reason: r.reason,
      pages: [r.address],
    })),
  )
  log.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1))
  return { pages, log, seq: 1 }
}

const last = (p: FxPage) => p.revs[p.revs.length - 1] as Rev
const addressOf = (p: FxPage) => last(p).address
const find = (w: Wiki, address: string) => w.pages.find((p) => p.addresses.includes(address))

const err = (status: number, code: string, message: string, howToProceed: string) => ({
  status,
  body: { error: { code, message, howToProceed } },
})
export const pageNotFound = (address: string) =>
  err(
    404,
    'page_not_found',
    `There is no page at "${address}" in this brain.`,
    'Check the address in the map (GET /v1/brains/:slug/wiki/map), or propose the page.',
  )

function stateOf(p: FxPage | undefined): 'ok' | 'broken' | 'stale' | 'retired' | 'superseded' {
  if (!p) return 'broken'
  const s = last(p).status
  return s === 'retired' || s === 'superseded' || s === 'stale' ? s : 'ok'
}
const mentionsOf = (body: string) =>
  [...body.matchAll(/\[\[([a-z0-9/-]+)(?:\|[^\]\n]*)?\]\]/g)].map((m) => m[1] as string)

function linksOut(w: Wiki, p: FxPage) {
  const r = last(p)
  const view = (kind: string, to: string) => {
    const t = find(w, to)
    return {
      kind,
      address: t ? addressOf(t) : to,
      pageId: t?.id ?? null,
      title: t ? last(t).title : null,
      state: stateOf(t),
    }
  }
  return [
    ...[...new Set(mentionsOf(r.body))].filter((a) => find(w, a) !== p).map((a) => view('mentions', a)),
    ...r.links.map((l) => view(l.kind, l.to)),
  ]
}

function reading(w: Wiki, p: FxPage, asked?: string) {
  const r = last(p)
  const linksIn = w.pages
    .filter((o) => o !== p)
    .flatMap((o) =>
      linksOut(w, o)
        .filter((l) => l.pageId === p.id)
        .map((l) => ({
          kind: l.kind,
          address: addressOf(o),
          pageId: o.id,
          title: last(o).title,
          state: stateOf(o),
        })),
    )
  const sup = p.supersededBy ? w.pages.find((x) => x.id === p.supersededBy) : undefined
  return {
    page: {
      id: p.id,
      brainId: 'brn_growth',
      address: r.address,
      type: r.type,
      title: r.title,
      summary: r.summary,
      body: r.body,
      tags: r.tags,
      status: r.status,
      supersededBy: p.supersededBy,
      revision: r.revision,
      createdAt: p.createdAt,
      updatedAt: r.createdAt,
    },
    ...(asked && asked !== r.address ? { redirectedFrom: asked } : {}),
    ...(r.status === 'retired' ? { notice: 'retired: this page is kept for its history only.' } : {}),
    ...(r.status === 'superseded' && sup ? { notice: `superseded by "${addressOf(sup)}".` } : {}),
    lastChange: { revision: r.revision, authorId: r.authorId, authorName: r.authorName, at: r.createdAt },
    corrections: w.corrections?.(p.addresses) ?? [],
    links: { out: linksOut(w, p), in: linksIn },
    sources: r.sources.map((s) =>
      'entryId' in s
        ? {
            entryId: s.entryId,
            title: ENTRIES[s.entryId]?.state === 'active' ? (ENTRIES[s.entryId]?.title ?? null) : null,
            state: ENTRIES[s.entryId]?.state ?? 'purged',
          }
        : { url: s.url, title: s.title ?? null },
    ),
  }
}

const summaryOf = (r: Rev) => ({
  revision: r.revision,
  address: r.address,
  title: r.title,
  status: r.status,
  kind: r.kind,
  change: r.change,
  restoredFrom: r.restoredFrom,
  reason: r.reason,
  authorId: r.authorId,
  authorName: r.authorName,
  proposalId: r.proposalId,
  corrected: false,
  baseReviewed: false,
  purged: null,
  createdAt: r.createdAt,
})
const fullOf = (r: Rev) => ({
  ...summaryOf(r),
  type: r.type,
  summary: r.summary,
  body: r.body,
  tags: r.tags,
  sources: r.sources,
  links: r.links,
})

function revise(
  w: Wiki,
  p: FxPage,
  who: Who,
  change: Partial<Rev>,
  kind: Rev['kind'],
  summary: string,
  why: { change: Rev['change']; reason: string | null; restoredFrom?: number },
) {
  const r = last(p)
  w.seq += 1
  const at = `2026-10-29T${String(10 + Math.floor(w.seq / 60)).padStart(2, '0')}:${String(w.seq % 60).padStart(2, '0')}:00.000Z`
  const next: Rev = {
    ...r,
    ...change,
    revision: r.revision + 1,
    kind,
    change: why.change,
    restoredFrom: why.restoredFrom ?? null,
    reason: why.reason,
    authorId: who.id,
    authorName: who.name,
    proposalId: null,
    createdAt: at,
  }
  p.revs.push(next)
  w.log.unshift({
    id: `log_fx_${w.seq}`,
    at,
    actorId: who.id,
    actorName: who.name,
    kind,
    proposalId: null,
    summary,
    reason: why.reason,
    pages: [next.address],
  })
  return { pageId: p.id, address: next.address, revision: next.revision }
}

// Another curator edits a page while a test looks at it (a control route of the tests).
export function editBehind(
  w: Wiki,
  address: string,
  body: string | undefined,
  more: Partial<Rev> = {},
): void {
  const p = find(w, address)
  if (p && more.address) p.addresses.push(more.address)
  if (p)
    revise(
      w,
      p,
      { id: 'acc_eva', name: 'Eva' },
      { ...(body === undefined ? {} : { body }), ...more },
      'direct',
      `Direct edit: ${address}`,
      {
        change: 'edited',
        reason: 'Eva fixed the numbers.',
      },
    )
}

type Q = URLSearchParams
type Answer = { status: number; body: unknown }

export function readPage(w: Wiki, address: string, query: Q): Answer {
  const p = find(w, address)
  if (!p) return pageNotFound(address)
  const rev = query.get('revision')
  const one = (n: number) => p.revs.find((r) => r.revision === n)
  const noRev = (n: string) =>
    err(404, 'revision_not_found', `Page "${addressOf(p)}" has no revision ${n}.`, 'See its history.')
  if (rev) {
    const r = one(Number(rev))
    return r ? { status: 200, body: { revision: fullOf(r) } } : noRev(rev)
  }
  const compare = query.get('compare')
  if (compare) {
    const [a, b] = compare.split(',').map(Number)
    const ra = one(a ?? 0)
    const rb = one(b ?? 0)
    if (!ra || !rb) return noRev(compare)
    return { status: 200, body: { a: fullOf(ra), b: fullOf(rb) } }
  }
  if (query.get('history') === '1') return { status: 200, body: { history: p.revs.map(summaryOf) } }
  const include = query.get('include')
  if (include && include !== 'history')
    return err(400, 'invalid_request', '"include" is "history", or left out.', 'Fix "include".')
  if (include === 'history')
    return { status: 200, body: { ...reading(w, p, address), history: p.revs.map(summaryOf) } }
  return { status: 200, body: reading(w, p, address) }
}

export function mapOf(w: Wiki, extra: GenPage[], every = false) {
  const shown = (status: string) => every || status === 'current'
  const all = [
    ...w.pages.filter((p) => shown(last(p).status)).map((p) => ({ ...last(p), tags: last(p).tags })),
    ...extra.filter((g) => shown(g.status)).map((g) => ({ ...g, body: '' })),
  ].sort((a, b) =>
    a.type !== b.type
      ? a.type < b.type
        ? -1
        : 1
      : a.address.split('/')[0] !== b.address.split('/')[0]
        ? (a.address.split('/')[0] as string) < (b.address.split('/')[0] as string)
          ? -1
          : 1
        : a.address < b.address
          ? -1
          : 1,
  )
  const groups: Array<{ type: string; area: string; pages: Array<Record<string, unknown>> }> = []
  for (const r of all) {
    const area = r.address.split('/')[0] as string
    let g = groups.at(-1)
    if (!g || g.type !== r.type || g.area !== area) {
      g = { type: r.type, area, pages: [] }
      groups.push(g)
    }
    g.pages.push({ address: r.address, title: r.title, summary: r.summary, tags: r.tags, status: r.status })
  }
  return {
    intro: 'The audience, the product and how we decide. Start with the overview pages.',
    groups,
    count: all.length,
  }
}

export function listOf(w: Wiki, extra: GenPage[], q: Q): Answer {
  const words = (q.get('q') ?? '').toLowerCase()
  const rows = [
    ...w.pages.map((p) => {
      const r = last(p)
      const out = linksOut(w, p)
      const into = w.pages.filter((o) => o !== p && linksOut(w, o).some((l) => l.pageId === p.id)).length
      return {
        address: r.address,
        title: r.title,
        type: r.type,
        status: r.status,
        tags: r.tags,
        in: into,
        out: out.length,
        updatedAt: r.createdAt,
      }
    }),
    ...extra.map((g) => ({ ...g, in: 1, out: 2, updatedAt: AT })),
  ]
    .filter(
      (r) =>
        (!words || r.address.includes(words) || r.title.toLowerCase().includes(words)) &&
        (!q.get('type') || r.type === q.get('type')) &&
        (!q.get('status') || r.status === q.get('status')) &&
        (!q.get('tag') || r.tags.includes(q.get('tag') as string)) &&
        (!q.get('prefix') || r.address.startsWith(`${q.get('prefix')}/`)),
    )
    .sort((a, b) => (a.address < b.address ? -1 : 1))
  const limit = Math.min(200, Number(q.get('limit') ?? 50) || 50)
  const after = q.get('cursor') ? Buffer.from(q.get('cursor') as string, 'base64url').toString() : ''
  const from = rows.filter((r) => r.address > after)
  const items = from.slice(0, limit)
  return {
    status: 200,
    body: {
      items: items.map(({ address, title, type, status, tags, in: i, out, updatedAt }) => ({
        address,
        title,
        type,
        status,
        tags,
        in: i,
        out,
        updatedAt,
      })),
      next: from.length > limit ? Buffer.from(items.at(-1)?.address ?? '').toString('base64url') : null,
      total: rows.length,
    },
  }
}

export function decisionsOf(w: Wiki, extra: GenPage[]) {
  return [
    ...w.pages.map((p) => ({ ...last(p), createdAt: p.createdAt, updatedAt: last(p).createdAt })),
    ...extra.map((g, i) => ({
      ...g,
      createdAt: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00.000Z`,
      updatedAt: AT,
    })),
  ]
    .filter((r) => r.type === 'decision' && r.status !== 'retired')
    .map((r) => ({
      address: r.address,
      title: r.title,
      summary: r.summary,
      status: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }))
}

export function logOf(w: Wiki, q: Q, many: boolean): Answer {
  const kind = q.get('kind')
  if (kind && !['proposal', 'direct', 'revert', 'purge'].includes(kind))
    return err(400, 'invalid_request', '"kind" is one of: proposal, direct, revert, purge.', 'Fix "kind".')
  const extra: Line[] = many
    ? Array.from({ length: 120 }, (_, i) => ({
        id: `log_many_${String(i).padStart(3, '0')}`,
        at: `2026-09-${String(28 - Math.floor(i / 5)).padStart(2, '0')}T10:00:00.000Z`,
        actorId: 'acc_eric',
        actorName: 'Eric',
        kind: 'proposal' as const,
        proposalId: `prp_many_${i}`,
        summary: `Approved: change ${120 - i}`,
        reason: null,
        pages: ['audience/retention'],
      }))
    : []
  const page = q.get('page')
  const rows = [...w.log, ...extra].filter(
    (l) => (!kind || l.kind === kind) && (!page || l.pages.includes(page)),
  )
  const limit = Math.min(200, Number(q.get('limit') ?? 50) || 50)
  const start = Number(q.get('cursor') ? Buffer.from(q.get('cursor') as string, 'base64url').toString() : 0)
  const items = rows.slice(start, start + limit)
  const end = start + limit
  return {
    status: 200,
    body: {
      items,
      total: rows.length,
      next: end < rows.length ? Buffer.from(String(end)).toString('base64url') : null,
    },
  }
}

export function readersOf(w: Wiki, address: string, curator: boolean, me: Who): Answer {
  const p = find(w, address)
  const all = p
    ? [
        {
          at: '2026-10-29T09:10:00.000Z',
          who: { id: 'acc_ana', name: 'Ana' },
          client: 'Claude Code',
          kind: 'read',
        },
        {
          at: '2026-10-29T09:30:00.000Z',
          who: { id: 'acc_ana', name: 'Ana' },
          client: 'Claude Code',
          kind: 'read',
        },
        {
          at: '2026-10-29T09:40:00.000Z',
          who: { id: 'acc_eric', name: 'Eric' },
          client: 'web',
          kind: 'read',
        },
        {
          at: '2026-10-29T09:55:00.000Z',
          who: { id: 'acc_eric', name: 'Eric' },
          client: 'RSC Factory',
          kind: 'context',
        },
      ]
    : []
  const seen = curator ? all : all.filter((x) => x.who.id === me.id)
  return {
    status: 200,
    body: {
      items: seen.map((x, i) => ({
        id: i + 1,
        at: x.at,
        kind: x.kind,
        query: null,
        resultIds: [p?.id ?? ''],
        account: x.who,
        credential: { id: `crd_${i}`, kind: x.client === 'web' ? 'web' : 'token', name: x.client },
        ref: null,
        sessionId: null,
      })),
      next: null,
    },
  }
}

const notCurator = err(
  403,
  'forbidden',
  'Your role in this brain does not allow this: it needs curator.',
  'Ask a curator of the brain (Eric) for the curator role.',
)

function changed(w: Wiki, revised: ReturnType<typeof revise>) {
  const p = w.pages.find((x) => x.id === revised.pageId) as FxPage
  return { revised: [revised], page: reading(w, p) }
}

export function editPage(
  w: Wiki,
  who: Who,
  curator: boolean,
  address: string,
  b: Record<string, unknown>,
): Answer {
  if (!curator) return notCurator
  const p = find(w, address)
  if (!p) return pageNotFound(address)
  const r = last(p)
  if (typeof b.baseRevision === 'number' && b.baseRevision !== r.revision) {
    return {
      status: 409,
      body: {
        error: {
          code: 'page_changed',
          message: `"${address}" changed since revision ${b.baseRevision}; it is at ${r.revision}. Nothing was saved.`,
          howToProceed:
            'Apply your change to the current version (in "current") and save it with its revision.',
          current: reading(w, p),
        },
      },
    }
  }
  if (typeof b.title === 'string' && b.title.length > 200)
    return {
      status: 400,
      body: {
        error: {
          code: 'invalid_request',
          message: 'The change has problems; nothing was saved.',
          howToProceed: 'Fix each one listed in "problems".',
          problems: [{ op: 0, message: '"title" is longer than 200 characters.' }],
        },
      },
    }
  const change: Partial<Rev> = {}
  for (const k of ['type', 'title', 'summary', 'body'] as const)
    if (typeof b[k] === 'string') change[k] = b[k]
  if (Array.isArray(b.tags)) change.tags = b.tags as string[]
  if (Array.isArray(b.sources)) change.sources = b.sources as Src[]
  return {
    status: 200,
    body: changed(
      w,
      revise(w, p, who, change, 'direct', `Direct edit: ${r.address}`, {
        change: 'edited',
        reason: typeof b.reason === 'string' ? b.reason : null,
      }),
    ),
  }
}

const bad = (message: string) =>
  ({
    status: 400,
    body: {
      error: {
        code: 'invalid_request',
        message: 'The change has problems; nothing was saved.',
        howToProceed: 'Fix each one listed in "problems".',
        problems: [{ op: 0, message }],
      },
    },
  }) as Answer

export function changeWiki(w: Wiki, who: Who, curator: boolean, b: Record<string, unknown>): Answer {
  if (!curator) return notCurator
  const address = String(b.address ?? '')
  const p = find(w, address)
  if (!p) return bad(`There is no page at "${address}".`)
  const r = last(p)
  const target = typeof b.to === 'string' ? find(w, b.to) : undefined
  switch (b.op) {
    case 'link':
    case 'unlink': {
      if (!target) return bad(`A typed link must point at a page that exists: "${String(b.to)}" does not.`)
      const to = addressOf(target)
      const links =
        b.op === 'link'
          ? [...r.links.filter((l) => !(l.kind === b.kind && l.to === to)), { kind: String(b.kind), to }]
          : r.links.filter((l) => !(l.kind === b.kind && l.to === to))
      return {
        status: 201,
        body: changed(
          w,
          revise(w, p, who, { links }, 'direct', `Direct ${b.op}: ${r.address}`, {
            change: 'linked',
            reason: typeof b.reason === 'string' ? b.reason : null,
          }),
        ),
      }
    }
    case 'status': {
      const by = typeof b.supersededBy === 'string' ? find(w, b.supersededBy) : undefined
      if (b.status === 'superseded' && b.supersededBy && !by)
        return bad(`There is no page at "${String(b.supersededBy)}".`)
      p.supersededBy = b.status === 'superseded' ? (by?.id ?? null) : null
      return {
        status: 201,
        body: changed(
          w,
          revise(
            w,
            p,
            who,
            { status: String(b.status) },
            'direct',
            `Direct status → ${String(b.status)}: ${r.address}`,
            { change: 'status', reason: typeof b.reason === 'string' ? b.reason : null },
          ),
        ),
      }
    }
    case 'move': {
      const to = String(b.to ?? '')
      if (!/^[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*$/.test(to))
        return bad(
          '"to" is not a valid address: lowercase words with hyphens, levels split by "/", e.g. "audience/retention".',
        )
      if (target && target !== p) return bad(`the address "${to}" is taken or reserved by another page.`)
      p.addresses.push(to)
      return {
        status: 201,
        body: changed(
          w,
          revise(w, p, who, { address: to }, 'direct', `Direct move: ${r.address}`, {
            change: 'moved',
            reason: typeof b.reason === 'string' ? b.reason : null,
          }),
        ),
      }
    }
    case 'revert': {
      const back = p.revs.find((x) => x.revision === b.toRevision)
      if (!back) return bad(`"${r.address}" has no revision ${String(b.toRevision)}.`)
      const { title, summary, body, tags, sources, links, type, status } = back
      return {
        status: 201,
        body: changed(
          w,
          revise(
            w,
            p,
            who,
            { title, summary, body, tags, sources, links, type, status },
            'revert',
            `Back to revision ${back.revision}: ${r.address}`,
            {
              change: 'restored',
              reason: typeof b.reason === 'string' ? b.reason : null,
              restoredFrom: back.revision,
            },
          ),
        ),
      }
    }
    default:
      return bad(`Unknown operation "${String(b.op)}".`)
  }
}

export function entryOf(id: string, slug: string): Answer {
  const e = ENTRIES[id]
  if (e?.state !== 'active')
    return err(404, 'not_found', 'No entry with that id is available to you.', 'Check the entry id.')
  return {
    status: 200,
    body: {
      entry: {
        id,
        brainId: `brn_${slug.replace(/-/g, '')}`,
        sessionId: 'ses_fx_1',
        type: e.type,
        topic: null,
        title: e.title,
        content: e.content,
        appliesTo: null,
        tags: [],
        refs: [],
        authorId: 'acc_ana',
        onBehalfId: null,
        ref: null,
        revision: 1,
        repeatCount: 1,
        pinned: false,
        reviewAfter: null,
        expiresAt: null,
        state: 'active',
        supersededBy: null,
        compiled: true,
        createdAt: '2026-10-14T09:00:00.000Z',
        updatedAt: '2026-10-14T09:00:00.000Z',
      },
    },
  }
}
