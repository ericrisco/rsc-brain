// The journal of a brain in the fixture API (spec B6 «Journal», B1; PR20): sessions with their client,
// author, entries and summary; entries with authorship, relations and history; a person's corrections;
// forgetting, recovering, pinning, dates and relations with the server's rules; conflicts, forgotten and
// to-review. Every answer is checked against the description of v1 (test/web/fixture.test.ts).
type Answer = { status: number; body: unknown }
type Q = URLSearchParams
type Named = { id: string; name: string }

const NOW = '2026-10-29T10:00:00.000Z'
const err = (status: number, code: string, message: string, howToProceed: string): Answer => ({
  status,
  body: { error: { code, message, howToProceed } },
})
const NO_ENTRY = err(404, 'not_found', 'No entry with that id is available to you.', 'Check the entry id.')
const NO_SESSION = err(
  404,
  'not_found',
  'No session with that id is available to you.',
  'Check the session id.',
)
const bad = (message: string, how: string) => err(400, 'invalid_request', message, how)
const ARCHIVED = err(
  403,
  'forbidden',
  'This brain is archived, so it is read-only.',
  'A curator of the brain can unarchive it (POST /v1/brains/:slug/unarchive).',
)
const needRole = (min: string, role: string | null) =>
  err(
    403,
    'forbidden',
    `This needs the ${min} role in the brain; you are ${role ?? 'not a member'}.`,
    `Ask a curator of the brain (Eric) for the ${min} role.`,
  )
const NOT_YOURS = err(
  403,
  'forbidden',
  'Only the author of an entry or a curator of the brain can change it.',
  'Ask a curator of the brain (Eric), or write a new entry.',
)

const NOT_TO_DECIDE = err(
  403,
  'forbidden',
  'Only the author of an entry or a curator of the brain can supersede it, or dismiss it when it is a correction.',
  'Ask a curator of the brain (Eric), or mark that the two entries contradict each other.',
)

const ERIC: Named = { id: 'acc_eric', name: 'Eric' }
const ANA: Named = { id: 'acc_ana', name: 'Ana' }
const FACTORY: Named = { id: 'acc_factory', name: 'RSC Factory' }

type Rev = {
  revision: number
  type: string
  title: string
  content: string
  appliesTo: string | null
  tags: string[]
  refs: string[]
  authorId: string
  authorName: string
  createdAt: string
}
export type FxEntry = {
  id: string
  brainId: string
  sessionId: string
  type: string
  topic: string | null
  title: string
  content: string
  appliesTo: string | null
  tags: string[]
  refs: string[]
  author: Named
  onBehalf: Named | null
  client: string | null
  ref: string | null
  revision: number
  repeatCount: number
  pinned: boolean
  reviewAfter: string | null
  expiresAt: string | null
  state: 'active' | 'forgotten' | 'purged'
  supersededBy: string | null
  compiled: boolean
  createdAt: string
  updatedAt: string
  forgotten: { by: Named; reason: string; at: string } | null
  history: Rev[]
}
type FxSession = {
  id: string
  brainId: string
  purpose: string
  ref: string | null
  status: 'open' | 'closed' | 'closed_no_summary'
  day: string | null
  client: string | null
  author: Named
  summaryEntryId: string | null
  openedAt: string
  lastActivityAt: string
  closedAt: string | null
}
type FxRelation = {
  id: string
  fromId: string
  toId: string
  kind: string
  status: 'active' | 'pending_person' | 'rejected'
  reason: string
  createdBy: Named
  createdAt: string
  // When a person decided on what an agent asked (it takes effect from then).
  decidedAt?: string
}
export type Journal = {
  slug: string
  sessions: FxSession[]
  entries: FxEntry[]
  relations: FxRelation[]
  seq: number
}

const at = (day: number, hour = 9) =>
  `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`

function entry(
  j: { brainId: string },
  id: string,
  sessionId: string,
  o: Partial<FxEntry> & { title: string; content: string; type: string; author: Named },
): FxEntry {
  const createdAt = o.createdAt ?? at(14)
  const e: FxEntry = {
    id,
    brainId: j.brainId,
    sessionId,
    topic: null,
    appliesTo: null,
    tags: [],
    refs: [],
    onBehalf: null,
    client: null,
    ref: null,
    revision: 1,
    repeatCount: 1,
    pinned: false,
    reviewAfter: null,
    expiresAt: null,
    state: 'active',
    supersededBy: null,
    compiled: false,
    updatedAt: createdAt,
    forgotten: null,
    history: [],
    ...o,
    createdAt,
  }
  e.history = [revOf(e, 1, createdAt)]
  return e
}

const revOf = (e: FxEntry, revision: number, createdAt: string, by: Named = e.author): Rev => ({
  revision,
  type: e.type,
  title: e.title,
  content: e.content,
  appliesTo: e.appliesTo,
  tags: e.tags,
  refs: e.refs,
  authorId: by.id,
  authorName: by.name,
  createdAt,
})

// The journal every brain of a scenario starts with. Growth's entry ids are those the wiki cites as
// sources (wiki.ts); other brains get their own ids, so an id names one entry.
export function freshJournal(slug: string): Journal {
  const brainId = `brn_${slug.replace(/-/g, '')}`
  const sfx = slug === 'growth' ? '' : `_${slug.replace(/-/g, '')}`
  const j: Journal = { slug, sessions: [], entries: [], relations: [], seq: 1 }
  const b = { brainId }
  const sid = (n: number) => `ses_fx_${n}${sfx}`
  const eid = (name: string) => `ent_fx_${name}${sfx}`
  j.sessions.push(
    {
      id: sid(1),
      brainId,
      purpose: 'Review the intros of October',
      ref: null,
      status: 'closed',
      day: null,
      client: 'Claude Code',
      author: ERIC,
      summaryEntryId: eid('summary'),
      openedAt: at(14, 8),
      lastActivityAt: at(14, 11),
      closedAt: at(14, 11),
    },
    {
      id: sid(2),
      brainId,
      purpose: 'Fix the onboarding emails',
      ref: 'repo web, branch emails',
      status: 'open',
      day: null,
      client: 'Codex',
      author: ANA,
      summaryEntryId: null,
      openedAt: at(28, 9),
      lastActivityAt: at(29, 9),
      closedAt: null,
    },
    {
      id: sid(3),
      brainId,
      purpose: 'Narrate the intro of video 41',
      ref: 'run r_77, step 3',
      status: 'closed_no_summary',
      day: null,
      client: 'narrator',
      author: FACTORY,
      summaryEntryId: null,
      openedAt: at(27, 15),
      lastActivityAt: at(27, 16),
      closedAt: at(28, 16),
    },
    {
      id: sid(4),
      brainId,
      purpose: 'implicit',
      ref: null,
      status: 'open',
      day: '2026-10-29',
      client: 'web',
      author: ERIC,
      summaryEntryId: null,
      openedAt: at(29, 8),
      lastActivityAt: at(29, 8),
      closedAt: null,
    },
    // A run of RSC Factory still going (Activity: its reference links to the run, CA9).
    {
      id: sid(5),
      brainId,
      purpose: 'Narrate the outro of video 42',
      ref: 'run r_3f9a1c2e, step 1',
      status: 'open',
      day: null,
      client: 'narrator',
      author: FACTORY,
      summaryEntryId: null,
      openedAt: at(26, 10),
      // Still working: its last write is now (Activity tells active sessions from quiet ones).
      lastActivityAt: new Date().toISOString(),
      closedAt: null,
    },
  )
  j.entries.push(
    entry(b, eid('intros'), sid(1), {
      type: 'learning',
      title: 'Short intros keep viewers',
      content: 'Intros under ten seconds kept 70% of viewers past the first minute in October.',
      author: ERIC,
      client: 'Claude Code',
      tags: ['intros', 'retention'],
      compiled: true,
      createdAt: at(14, 9),
    }),
    entry(b, eid('hooks'), sid(1), {
      type: 'decision',
      title: 'The hook goes first',
      content: 'Starting with the question of the video, before the greeting, lifted retention by a fifth.',
      author: ERIC,
      client: 'Claude Code',
      compiled: true,
      createdAt: at(14, 10),
    }),
    entry(b, eid('summary'), sid(1), {
      type: 'summary',
      title: 'Session summary',
      content:
        'Goal: review the October intros.\n\nShort intros keep viewers past 30 seconds; the long ones lose a third of them before the hook. Next: rewrite the three longest.',
      author: ERIC,
      client: 'Claude Code',
      createdAt: at(14, 11),
    }),
    entry(b, eid('30s'), sid(2), {
      type: 'learning',
      title: 'Thirty-second intros work best',
      content: 'In the support videos, intros of about thirty seconds kept the most viewers.',
      author: ANA,
      client: 'Codex',
      createdAt: at(28, 10),
    }),
    entry(b, eid('plain'), sid(2), {
      type: 'attempt',
      title: 'Plain-text onboarding emails',
      content:
        'Tried plain-text emails for onboarding: no change in opens. Keep the HTML ones.\n\n<script>window.__pwned = 9</script>',
      author: ANA,
      client: 'Codex',
      ref: null,
      reviewAfter: at(20),
      createdAt: at(28, 11),
    }),
    entry(b, eid('take'), sid(3), {
      type: 'step',
      title: 'Narrated the intro of video 41',
      content: 'Took three takes; the second one is the keeper.',
      author: FACTORY,
      onBehalf: ERIC,
      client: 'narrator',
      ref: 'run r_77, step 3',
      createdAt: at(27, 16),
    }),
    entry(b, eid('long'), sid(3), {
      type: 'learning',
      title: 'Greetings help the narrator',
      content: 'A greeting before the hook gives the narrator a warm start.',
      author: FACTORY,
      onBehalf: ERIC,
      client: 'narrator',
      ref: 'run r_77, step 3',
      createdAt: at(27, 16),
    }),
    entry(b, eid('corr'), sid(4), {
      type: 'correction',
      title: 'No greeting before the hook',
      content: 'Cut the greeting; open with the question of the video.',
      author: ERIC,
      client: 'web',
      appliesTo: 'narrator',
      refs: ['page:audience/intros'],
      createdAt: at(29, 8),
    }),
    entry(b, eid('gone'), sid(2), {
      type: 'note',
      title: 'Old pricing note',
      content: 'Monthly plans only.',
      author: ANA,
      client: 'Codex',
      state: 'forgotten',
      forgotten: { by: ERIC, reason: 'Replaced by the annual plans decision.', at: at(28, 12) },
      createdAt: at(15),
    }),
  )
  j.relations.push(
    {
      id: `rel_fx_1${sfx}`,
      fromId: eid('30s'),
      toId: eid('intros'),
      kind: 'contradicts',
      status: 'active',
      reason: 'Thirty seconds against ten.',
      createdBy: ANA,
      createdAt: at(28, 10),
    },
    {
      id: `rel_fx_2${sfx}`,
      fromId: eid('long'),
      toId: eid('corr'),
      kind: 'supersedes',
      status: 'pending_person',
      reason: 'The narrator likes a greeting.',
      createdBy: FACTORY,
      createdAt: at(29, 9),
    },
  )
  return j
}

// Many sessions, entries and conflicts, for the "much data" state of each list.
export function bigJournal(slug: string): Journal {
  const j = freshJournal(slug)
  const brainId = `brn_${slug.replace(/-/g, '')}`
  for (let i = 0; i < 500; i++) {
    const id = `ses_many_${String(i).padStart(3, '0')}`
    j.sessions.push({
      id,
      brainId,
      purpose: `Work item ${i + 1}: intros, hooks and retention`,
      ref: i % 5 === 0 ? `run r_${i}, step 1` : null,
      status: i % 3 === 0 ? 'open' : 'closed',
      day: null,
      client: ['Claude Code', 'Codex', 'narrator'][i % 3] ?? null,
      author: i % 2 ? ANA : ERIC,
      summaryEntryId: null,
      openedAt: new Date(Date.parse(at(1)) + i * 3_600_000).toISOString(),
      lastActivityAt: new Date(Date.parse(at(1)) + i * 3_600_000).toISOString(),
      closedAt: null,
    })
  }
  for (let i = 0; i < 120; i++) {
    const a = entry({ brainId }, `ent_many_a${i}`, 'ses_many_000', {
      type: 'learning',
      title: `Claim ${i + 1}`,
      content: `Claim ${i + 1} holds for the October videos.`,
      author: ANA,
      client: 'Codex',
      reviewAfter: at(20),
    })
    const b = entry({ brainId }, `ent_many_b${i}`, 'ses_many_000', {
      type: 'learning',
      title: `Counter-claim ${i + 1}`,
      content: `Claim ${i + 1} does not hold.`,
      author: ERIC,
      client: 'Claude Code',
      state: 'forgotten',
      forgotten: { by: ERIC, reason: `Duplicate of claim ${i + 1}.`, at: at(28) },
    })
    j.entries.push(a, b)
    const c = entry({ brainId }, `ent_many_c${i}`, 'ses_many_000', {
      type: 'learning',
      title: `Other claim ${i + 1}`,
      content: `Claim ${i + 1} is the other way round.`,
      author: ERIC,
      client: 'Claude Code',
    })
    j.entries.push(c)
    j.relations.push({
      id: `rel_many_${i}`,
      fromId: a.id,
      toId: c.id,
      kind: 'contradicts',
      status: 'active',
      reason: '',
      createdBy: ANA,
      createdAt: at(28),
    })
  }
  return j
}

const sessionView = (j: Journal, s: FxSession) => {
  const summary = s.summaryEntryId
    ? j.entries.find((e) => e.id === s.summaryEntryId && e.state === 'active')
    : null
  return {
    id: s.id,
    brainId: s.brainId,
    accountId: s.author.id,
    credentialId: `crd_${s.id}`,
    bound: false,
    purpose: s.purpose,
    ref: s.ref,
    status: s.status,
    summaryEntryId: s.summaryEntryId,
    openedAt: s.openedAt,
    lastActivityAt: s.lastActivityAt,
    closedAt: s.closedAt,
    day: s.day,
    client: s.client,
    author: s.author,
    entries: j.entries.filter((e) => e.sessionId === s.id && e.state === 'active' && e.type !== 'summary')
      .length,
    forgotten: j.entries.filter((e) => e.sessionId === s.id && e.state === 'forgotten').length,
    summary: summary ? summary.content.slice(0, 300) : null,
  }
}

const TYPES = [
  'decision',
  'learning',
  'attempt',
  'correction',
  'preference',
  'fact',
  'step',
  'summary',
  'note',
]
const STATUSES = ['open', 'closed', 'closed_no_summary']

// Pages of a list: the cursor is where the next page starts.
function paged<T>(all: T[], q: Q, def = 50): { items: T[]; next: string | null } | Answer {
  const limit = q.get('limit') ? Number(q.get('limit')) : def
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    return bad('"limit" must be between 1 and 200.', 'Ask for at most 200 per page.')
  const cur = q.get('cursor')
  const start = cur ? Number(cur.replace(/^o/, '')) : 0
  if (!Number.isInteger(start) || start < 0)
    return bad('The cursor is not valid.', 'Use the "next" value of the previous page, unchanged.')
  const items = all.slice(start, start + limit)
  return { items, next: start + limit < all.length ? `o${start + limit}` : null }
}
const isAnswer = (x: unknown): x is Answer => typeof x === 'object' && x !== null && 'status' in x

export function sessionsOf(j: Journal, q: Q, liveFrom: string): Answer {
  const status = q.get('status') || undefined
  const type = q.get('type') || undefined
  if (status && !STATUSES.includes(status))
    return bad(`Unknown status "${status}".`, `Use one of: ${STATUSES.join(', ')}.`)
  if (type && !TYPES.includes(type))
    return bad(`Unknown entry type "${type}".`, `Use one of: ${TYPES.join(', ')}.`)
  for (const k of ['from', 'to'])
    if (q.get(k) && Number.isNaN(Date.parse(q.get(k) as string)))
      return bad(`"${k}" is not a date.`, 'Send a day like 2026-10-29, or an ISO instant.')
  const client = q.get('client') || undefined
  const author = q.get('author') || undefined
  const ref = (q.get('ref') || '').toLowerCase()
  const from = q.get('from') ? Date.parse(q.get('from') as string) : null
  const to = q.get('to')
    ? Date.parse(q.get('to') as string) + ((q.get('to') as string).length === 10 ? 86_400_000 : 1)
    : null
  const uncompiled = q.get('uncompiled') === '1'
  const list = j.sessions
    .filter((s) => !status || s.status === status)
    .filter((s) => !client || s.client === client)
    .filter((s) => !author || s.author.id === author)
    .filter(
      (s) =>
        !ref ||
        (s.ref ?? '').toLowerCase().includes(ref) ||
        j.entries.some((e) => e.sessionId === s.id && (e.ref ?? '').toLowerCase().includes(ref)),
    )
    .filter(
      (s) => !type || j.entries.some((e) => e.sessionId === s.id && e.state === 'active' && e.type === type),
    )
    .filter(
      (s) =>
        !uncompiled ||
        j.entries.some(
          (e) => e.sessionId === s.id && e.state === 'active' && !e.compiled && e.type !== 'summary',
        ),
    )
    .filter((s) => from === null || Date.parse(s.lastActivityAt) >= from)
    .filter((s) => to === null || Date.parse(s.openedAt) < to)
    .sort((a, b) => (a.openedAt < b.openedAt ? 1 : a.openedAt > b.openedAt ? -1 : a.id < b.id ? 1 : -1))
  const page = paged(list, q)
  if (isAnswer(page)) return page
  const first = !q.get('cursor')
  const clients = [...new Set(j.sessions.map((s) => s.client).filter((c): c is string => !!c))].sort()
  const authors = [...new Map(j.sessions.map((s) => [s.author.id, s.author])).values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  )
  return {
    status: 200,
    body: {
      items: page.items.map((s) => sessionView(j, s)),
      total: list.length,
      next: page.next,
      liveFrom,
      ...(first ? { facets: { clients, authors } } : {}),
    },
  }
}

export function sessionOf(j: Journal, id: string): Answer | null {
  const s = j.sessions.find((x) => x.id === id)
  return s ? { status: 200, body: { session: sessionView(j, s) } } : null
}

const plain = (e: FxEntry) => {
  const { author, onBehalf, client, forgotten, history, ...rest } = e
  return { ...rest, authorId: author.id, onBehalfId: onBehalf?.id ?? null }
}
const read = (e: FxEntry) => ({
  ...plain(e),
  author: e.author,
  onBehalf: e.onBehalf,
  client: e.client,
  forgotten: e.forgotten,
})

// The session an entry is in, named by its purpose.
const sessionRef = (j: Journal, id: string) => {
  const s = j.sessions.find((x) => x.id === id)
  return { id, purpose: s?.purpose ?? '', day: s?.day ?? null }
}

export function entriesOf(j: Journal, q: Q): Answer {
  const session = q.get('session')
  // Entries about a page, written since a moment (Health: «N newer entries about it»).
  const about = q.get('about')
  const since = q.get('since')
  if (about !== null && !/^[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*$/.test(about))
    return {
      status: 400,
      body: {
        error: {
          code: 'invalid_request',
          message: '"about" is the address of a page, like "style/intros".',
          howToProceed: 'Use the address as the wiki shows it.',
        },
      },
    }
  const list = j.entries
    .filter((e) => e.state === 'active' && (!session || e.sessionId === session))
    .filter((e) => !about || e.topic === about || e.content.includes(about))
    .filter((e) => !since || e.createdAt > since)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
  const page = paged(list, q)
  if (isAnswer(page)) return page
  const open = new Set(openConflicts(j).flatMap((r) => [r.fromId, r.toId]))
  return {
    status: 200,
    body: {
      items: page.items.map((e) => ({ ...plain(e), conflict: open.has(e.id) })),
      total: list.length,
      next: page.next,
    },
  }
}

export function entryRead(j: Journal, e: FxEntry, curator: boolean, history: boolean): Answer {
  if (e.state === 'forgotten' && !curator) return NO_ENTRY
  const relations = j.relations
    .filter((r) => r.fromId === e.id || r.toId === e.id)
    .map((r) => {
      const otherId = r.fromId === e.id ? r.toId : r.fromId
      const o = j.entries.find((x) => x.id === otherId) as FxEntry
      const hidden = o.state === 'purged' || (o.state === 'forgotten' && !curator)
      return {
        id: r.id,
        kind: r.kind,
        status: r.status,
        direction: r.fromId === e.id ? 'out' : 'in',
        other: { id: o.id, title: hidden ? null : o.title, type: o.type, state: o.state },
        reason: hidden ? null : r.reason,
        by: r.createdBy,
        createdAt: r.createdAt,
      }
    })
  return {
    status: 200,
    body: {
      entry: read(e),
      session: sessionRef(j, e.sessionId),
      relations,
      ...(history ? { history: e.history } : {}),
    },
  }
}

type Who = { role: string | null; me: Named; archived: boolean }
const RANK: Record<string, number> = { reader: 1, contributor: 2, curator: 3 }
const atLeast = (role: string | null, min: string) => (RANK[role ?? ''] ?? 0) >= (RANK[min] ?? 99)

function mayChange(e: FxEntry, w: Who): Answer | null {
  if (w.archived) return ARCHIVED
  if (atLeast(w.role, 'curator')) return null
  if (e.author.id === w.me.id && atLeast(w.role, 'contributor')) return null
  return NOT_YOURS
}

const FORGOTTEN_NOW = err(409, 'entry_forgotten', 'This entry is forgotten.', 'Recover it first.')

export function editEntry(_j: Journal, e: FxEntry, w: Who, b: Record<string, unknown>): Answer {
  const no = mayChange(e, w)
  if (no) return no
  if (e.state !== 'active') return FORGOTTEN_NOW
  if (typeof b.baseRevision !== 'number')
    return bad('"baseRevision" is required.', 'Add "baseRevision" to the request.')
  if (b.baseRevision !== e.revision) {
    return {
      status: 409,
      body: {
        error: {
          code: 'entry_changed',
          message: `The entry changed since revision ${b.baseRevision}; it is now at revision ${e.revision}.`,
          howToProceed:
            'Read the current version (in "current"), apply your change to it and send it with its revision.',
          current: plain(e),
        },
      },
    }
  }
  const title = typeof b.title === 'string' ? b.title.trim() : e.title
  const content = typeof b.content === 'string' ? b.content : e.content
  if (!title) return bad('An entry needs a title.', 'Give it a one-line title.')
  if (!content.trim()) return bad('An entry needs content.', 'Say what, why, where and what you learned.')
  e.title = title
  e.content = content.replace(/<private>[\s\S]*?<\/private>/g, '[private removed]')
  e.revision += 1
  e.updatedAt = NOW
  e.history.push(revOf(e, e.revision, NOW, w.me))
  return { status: 200, body: { entry: plain(e) } }
}

// Another person corrects an entry meanwhile (the conflict of an edit).
export function editBehind(e: FxEntry, content: string): void {
  e.content = content
  e.revision += 1
  e.history.push(revOf(e, e.revision, NOW, ANA))
}

export function forgetEntry(e: FxEntry, w: Who, b: Record<string, unknown>): Answer {
  const why = typeof b.reason === 'string' ? b.reason.trim() : ''
  if (!why || why.length > 500) return bad('Say why, in 1 to 500 characters.', 'Add a short reason.')
  const no = mayChange(e, w)
  if (no) return no
  if (e.state === 'active') {
    e.state = 'forgotten'
    e.forgotten = { by: w.me, reason: why, at: NOW }
  }
  return { status: 200, body: { entry: plain(e) } }
}

export function recoverEntry(e: FxEntry, w: Who): Answer {
  if (!atLeast(w.role, 'curator')) return needRole('curator', w.role)
  if (w.archived) return ARCHIVED
  e.state = 'active'
  e.forgotten = null
  return { status: 200, body: { entry: plain(e) } }
}

export function pinEntry(e: FxEntry, w: Who, pinned: boolean): Answer {
  if (!atLeast(w.role, 'curator')) return needRole('curator', w.role)
  if (w.archived) return ARCHIVED
  if (e.state !== 'active') return FORGOTTEN_NOW
  e.pinned = pinned
  return { status: 200, body: { entry: plain(e) } }
}

export function scheduleEntry(e: FxEntry, w: Who, b: Record<string, unknown>): Answer {
  const no = mayChange(e, w)
  if (no) return no
  for (const k of ['reviewAfter', 'expiresAt'] as const) {
    if (!(k in b)) continue
    const v = b[k]
    if (v === null) e[k] = null
    else if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) e[k] = new Date(v).toISOString()
    else return bad(`"${k}" is not a date.`, 'Send an ISO date, or null to clear it.')
  }
  return { status: 200, body: { entry: plain(e) } }
}

export function relate(j: Journal, w: Who, b: Record<string, unknown>): Answer {
  const kind = String(b.kind ?? '')
  if (!['contradicts', 'supersedes', 'not_related'].includes(kind))
    return bad(`Unknown relation "${kind}".`, 'Use one of: contradicts, supersedes, not_related.')
  if (b.from === b.to) return bad('An entry cannot relate to itself.', 'Name two different entries.')
  if (!atLeast(w.role, 'contributor')) return needRole('contributor', w.role)
  if (w.archived) return ARCHIVED
  const from = j.entries.find((e) => e.id === b.from && e.state === 'active')
  const to = j.entries.find((e) => e.id === b.to && e.state === 'active')
  if (!from || !to) return NO_ENTRY
  // Superseding an entry, or dismissing a correction: its author or a curator (the web is a person). An
  // answer to what an agent asked about one's own entry (the reverse supersede, waiting) is about that one.
  const answering =
    kind === 'supersedes' &&
    j.relations.some(
      (r) =>
        r.status === 'pending_person' && r.kind === 'supersedes' && r.fromId === to.id && r.toId === from.id,
    )
  const decided =
    kind === 'supersedes'
      ? [answering ? from : to]
      : kind === 'not_related'
        ? [from, to].filter((x) => x.type === 'correction')
        : []
  if (!atLeast(w.role, 'curator') && decided.some((x) => x.author.id !== w.me.id)) return NOT_TO_DECIDE
  // The web is a person: what waited for one on this pair is settled.
  let confirmed: FxRelation | null = null
  if (kind !== 'contradicts') {
    for (const r of j.relations) {
      const pair = (r.fromId === from.id && r.toId === to.id) || (r.fromId === to.id && r.toId === from.id)
      if (!pair || r.status !== 'pending_person') continue
      const same = !confirmed && r.fromId === from.id && r.toId === to.id && r.kind === kind
      if (same) confirmed = r
      r.status = same ? 'active' : 'rejected'
      r.decidedAt = NOW
    }
  }
  if (kind === 'supersedes') {
    let x: FxEntry | undefined = from
    while (x?.supersededBy) {
      if (x.supersededBy === to.id)
        return err(
          409,
          'relation_cycle',
          'That would make entries supersede each other in a loop.',
          'Pick the one that wins.',
        )
      x = j.entries.find((e) => e.id === x?.supersededBy)
    }
    to.supersededBy = from.id
  }
  const rel: FxRelation = confirmed ?? {
    id: `rel_fx_new${j.seq++}`,
    fromId: from.id,
    toId: to.id,
    kind,
    status: 'active',
    reason: typeof b.reason === 'string' ? b.reason.trim() : '',
    createdBy: w.me,
    createdAt: NOW,
  }
  if (!confirmed) j.relations.push(rel)
  const { createdBy, decidedAt: _d, ...r } = rel
  return { status: 201, body: { relation: { ...r, createdBy: createdBy.id } } }
}

const settled = (j: Journal, r: FxRelation) =>
  j.relations.some(
    (s) =>
      s.status === 'active' &&
      (s.kind === 'supersedes' || s.kind === 'not_related') &&
      (s.decidedAt ?? s.createdAt) >= r.createdAt &&
      ((s.fromId === r.fromId && s.toId === r.toId) || (s.fromId === r.toId && s.toId === r.fromId)),
  )

// The open conflicts, as the server counts them (domain/relations.ts OPEN_CONFLICT).
const active = (j: Journal, id: string) => j.entries.find((e) => e.id === id && e.state === 'active')
const openConflicts = (j: Journal) =>
  j.relations.filter(
    (r) =>
      ((r.kind === 'contradicts' && r.status === 'active' && !settled(j, r)) ||
        r.status === 'pending_person') &&
      active(j, r.fromId) &&
      active(j, r.toId),
  )

export function conflictsOf(j: Journal, q: Q): Answer {
  const side = (e: FxEntry) => ({ ...read(e), session: sessionRef(j, e.sessionId) })
  const out = openConflicts(j).map((r) => {
    const { createdBy, decidedAt: _d, ...rel } = r
    return {
      relation: { ...rel, createdBy: createdBy.id },
      from: side(active(j, r.fromId) as FxEntry),
      to: side(active(j, r.toId) as FxEntry),
      why: r.status === 'pending_person' ? 'waiting for a person' : 'contradicts',
    }
  })
  const limit = q.get('limit') ? Number(q.get('limit')) : undefined
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200))
    return bad('"limit" must be between 1 and 200.', 'Ask for at most 200 per page.')
  const offset = q.get('offset') ? Number(q.get('offset')) : 0
  const end = limit === undefined ? out.length : offset + limit
  return {
    status: 200,
    body: {
      conflicts: out.slice(offset, end),
      total: out.length,
      next: end < out.length ? String(end) : null,
    },
  }
}

export function forgottenOf(j: Journal, w: Who, q: Q): Answer {
  if (!atLeast(w.role, 'curator'))
    return err(403, 'forbidden', 'Only curators see forgotten entries.', 'Ask a curator of the brain.')
  const list = j.entries.filter((e) => e.state === 'forgotten')
  const page = paged(list, q)
  if (isAnswer(page)) return page
  return { status: 200, body: { items: page.items.map(read), total: list.length, next: page.next } }
}

export function toReviewOf(j: Journal, q: Q): Answer {
  const list = j.entries.filter((e) => e.state === 'active' && e.reviewAfter !== null && e.reviewAfter <= NOW)
  const page = paged(list, q)
  if (isAnswer(page)) return page
  return { status: 200, body: { items: page.items.map(read), total: list.length, next: page.next } }
}

export function addCorrection(
  j: Journal,
  w: Who,
  b: Record<string, unknown>,
  pageExists: (address: string) => boolean,
): Answer {
  const title = typeof b.title === 'string' ? b.title.trim() : ''
  const content = typeof b.content === 'string' ? b.content : ''
  if (typeof b.title !== 'string') return bad('"title" is required.', 'Add "title" to the request.')
  if (typeof b.content !== 'string') return bad('"content" is required.', 'Add "content" to the request.')
  if (b.page !== undefined && b.entry !== undefined)
    return bad('A correction is about one page or one entry, not both.', 'Send "page" or "entry".')
  if (!atLeast(w.role, 'contributor')) return needRole('contributor', w.role)
  if (w.archived) return ARCHIVED
  const refs: string[] = []
  if (typeof b.page === 'string') {
    if (!pageExists(b.page))
      return err(
        404,
        'page_not_found',
        `There is no page at "${b.page}" in this brain.`,
        'Check the address in the map (GET /v1/brains/:slug/wiki/map), or propose the page.',
      )
    refs.push(`page:${b.page}`)
  }
  if (typeof b.entry === 'string') {
    if (!j.entries.some((e) => e.id === b.entry && e.state === 'active')) return NO_ENTRY
    refs.push(`entry:${b.entry}`)
  }
  if (!title) return bad('An entry needs a title.', 'Give it a one-line title.')
  if (!content.trim()) return bad('An entry needs content.', 'Say what, why, where and what you learned.')
  const today = j.sessions.find((s) => s.day === '2026-10-29' && s.author.id === w.me.id)
  const sessionId = today?.id ?? `ses_fx_web_${w.me.id}`
  if (!today)
    j.sessions.push({
      id: sessionId,
      brainId: `brn_${j.slug.replace(/-/g, '')}`,
      purpose: 'implicit',
      ref: null,
      status: 'open',
      day: '2026-10-29',
      client: 'web',
      author: w.me,
      summaryEntryId: null,
      openedAt: NOW,
      lastActivityAt: NOW,
      closedAt: null,
    })
  const appliesTo = typeof b.appliesTo === 'string' && b.appliesTo.trim() ? b.appliesTo.trim() : null
  const e = entry({ brainId: `brn_${j.slug.replace(/-/g, '')}` }, `ent_fx_new${j.seq++}`, sessionId, {
    type: 'correction',
    title,
    content,
    author: w.me,
    client: 'web',
    appliesTo,
    refs,
    createdAt: NOW,
  })
  j.entries.push(e)
  return {
    status: 201,
    body: {
      receipt: {
        entryId: e.id,
        revision: 1,
        at: NOW,
        deduplicated: false,
        repeatCount: 1,
        redactions: 0,
        similar: [],
      },
    },
  }
}

// An agent asks for a relation that waits for a person (a key touching a person's correction).
export function agentAsks(j: Journal, from: string, to: string, kind: string): void {
  j.relations.push({
    id: `rel_fx_new${j.seq++}`,
    fromId: from,
    toId: to,
    kind,
    status: 'pending_person',
    reason: '',
    createdBy: FACTORY,
    createdAt: NOW,
  })
}

// The corrections in force about a page, under any of its addresses (GET a page's «corrections»).
export function correctionsAbout(j: Journal, addresses: string[]) {
  const refs = new Set(addresses.map((a) => `page:${a}`))
  return j.entries
    .filter(
      (e) =>
        e.type === 'correction' &&
        e.state === 'active' &&
        !e.supersededBy &&
        (!e.expiresAt || e.expiresAt > NOW) &&
        e.refs.some((r) => refs.has(r)),
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .map((e) => ({
      id: e.id,
      title: e.title,
      appliesTo: e.appliesTo,
      author: e.author,
      createdAt: e.createdAt,
    }))
}

export { NO_ENTRY, NO_SESSION }
