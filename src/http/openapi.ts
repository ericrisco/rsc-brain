// The description of the API (spec B5 «La API»: a program can use it without reading the code). It is
// generated from the route table, so no route is left out, with hand-written shapes for the answers a
// program relies on most. Served at GET /v1/openapi.json without a key: it describes, it holds no data.
// The routes and the pinned fields are a contract (CA18, test/api/contract.test.ts).
import type { Route } from './router.ts'

type Schema = Record<string, unknown>
type Op = {
  summary: string
  status?: number
  body?: Schema
  reply?: Schema
  stream?: boolean
  // The answer is an image, not JSON (the logo of the installation).
  image?: boolean
  query?: Record<string, string>
}

const s = (description: string, extra: Schema = {}): Schema => ({ type: 'string', description, ...extra })
const n = (description: string): Schema => ({ type: 'integer', description })
const b = (description: string): Schema => ({ type: 'boolean', description })
const nul = (x: Schema): Schema => ({ ...x, type: [x.type, 'null'] })
const list = (items: Schema, description = ''): Schema => ({ type: 'array', items, description })
// An object whose listed fields are always there (more may be added within v1, none removed).
const obj = (properties: Record<string, Schema>, optional: string[] = []): Schema => ({
  type: 'object',
  properties,
  required: Object.keys(properties).filter((k) => !optional.includes(k)),
})
const NEXT = nul(s('The value to ask for the next page with; null on the last page.'))

const BRAIN = obj({
  id: s('Its id (brn_…).'),
  slug: s('Its name in addresses.'),
  name: s('Display name.'),
  description: s('More about it.'),
  purpose: s('What it is for.'),
  status: s('active or archived.', { enum: ['active', 'archived'] }),
  pendingCuratorEmail: nul(s('The email invited as its first curator, until accepted.')),
  createdAt: s('When.', { format: 'date-time' }),
  updatedAt: s('When it last changed.', { format: 'date-time' }),
})
const STATS = obj({
  pages: n('Wiki pages that are not retired.'),
  entries: n('Active journal entries.'),
  uncompiled: n('Active entries no proposal has gathered yet.'),
  conflicts: n('Open contradictions between entries.'),
  pendingProposals: n('Proposals waiting for a curator.'),
  lastActivityAt: nul(s('The last write, session or proposal.', { format: 'date-time' })),
})
const BRAIN_ROLE = {
  ...BRAIN,
  properties: {
    ...(BRAIN.properties as Schema),
    role: s('Your role through this key.'),
    stats: STATS,
    notifyProposals: b('You get an email for each new proposal of this brain.'),
  },
  required: [...(BRAIN.required as string[]), 'role', 'stats', 'notifyProposals'],
}
const INVITED = obj({
  id: s('Invitation id (inv_…).'),
  email: s('Who it is for.'),
  link: s('The single-use link (72 hours). Shown only in this answer: copy it now if it was not mailed.'),
  expiresAt: s('Until when it works.', { format: 'date-time' }),
  mailed: b('It went by email.'),
  mailError: nul(s('Why the email did not go, if it did not.')),
})
const SESSION = obj({
  id: s('Session id (ses_…).'),
  brainId: s('Its brain.'),
  accountId: s('Who opened it.'),
  credentialId: s('With which key.'),
  bound: b('Opened by a service for one of its short keys.'),
  purpose: s('What it is for.'),
  ref: nul(s('External reference.')),
  status: s('open, closed or closed_no_summary.'),
  summaryEntryId: nul(s('The summary entry, once closed with one.')),
  openedAt: s('When.', { format: 'date-time' }),
  lastActivityAt: s('Last write.', { format: 'date-time' }),
  closedAt: nul(s('When.', { format: 'date-time' })),
})
const ENTRY = obj({
  id: s('Entry id (ent_…).'),
  brainId: s('Its brain.'),
  sessionId: s('Its session.'),
  type: s('decision, learning, attempt, correction, preference, fact, step, summary or note.'),
  topic: nul(s('Topic key, for what evolves.')),
  title: s('Title.'),
  content: s('The entry, already redacted.'),
  appliesTo: nul(s('The agent, account or label it applies to.')),
  tags: list(s('A tag.')),
  refs: list(
    s('A file, link or id; a correction written in the web names "page:<address>" or "entry:<id>".'),
  ),
  authorId: s('The account that wrote it.'),
  onBehalfId: nul(s('The person a service relayed it for.')),
  ref: nul(s('The external reference stamped by the short key that wrote it.')),
  revision: n('Its revision, for corrections against it.'),
  repeatCount: n('How many times it was saved.'),
  pinned: b('Always in the start context (curators pin).'),
  reviewAfter: nul(s('After this, it is to review.', { format: 'date-time' })),
  expiresAt: nul(s('After this, it leaves the default context.', { format: 'date-time' })),
  state: s('active, forgotten or purged.'),
  supersededBy: nul(s('The entry that supersedes it.')),
  compiled: b('A wiki proposal gathered it.'),
  createdAt: s('When.', { format: 'date-time' }),
  updatedAt: s('When it last changed.', { format: 'date-time' }),
})
const NAMED = obj({ id: s('Account id.'), name: s('Name.') })
// An entry as a person reads it (the journal in the web, B6 PR20): who wrote it and with what, and, for a
// forgotten one (only curators see it), who forgot it, when and why.
const BYLINE = {
  author: NAMED,
  onBehalf: nul({ ...NAMED, description: 'The person a service relayed it for.' }),
  client: nul(s('What wrote it: web, the agent of a short key, the app of a connection, or a program.')),
  forgotten: nul({
    ...obj({ by: NAMED, reason: s('Why.'), at: s('When.', { format: 'date-time' }) }),
    description: 'Who forgot it, why and when; null unless forgotten.',
  }),
}
const ENTRY_READ = {
  ...ENTRY,
  properties: { ...(ENTRY.properties as Schema), ...BYLINE },
  required: [...(ENTRY.required as string[]), ...Object.keys(BYLINE)],
}
const RELATION = obj({
  id: s('Relation id (rel_…).'),
  fromId: s('The entry that contradicts, supersedes or is not related.'),
  toId: s('The other entry.'),
  kind: s('contradicts, supersedes or not_related.'),
  status: s('active; pending_person while a person has to confirm what an agent asked; rejected.'),
  reason: s('Why.'),
  createdBy: s('Who.'),
  createdAt: s('When.', { format: 'date-time' }),
})
const ENTRY_RELATION = obj({
  id: s('Relation id.'),
  kind: s('contradicts, supersedes or not_related.'),
  status: s('active, pending_person or rejected.'),
  direction: s('out: this entry is its "from"; in: its "to".', { enum: ['out', 'in'] }),
  other: obj({
    id: s('The other entry.'),
    title: nul(s('Its title; null when purged, or forgotten and you are not a curator.')),
    type: s('Its type.'),
    state: s('active, forgotten or purged.'),
  }),
  reason: nul(s('Why; null when the other entry’s title is hidden from you.')),
  by: NAMED,
  createdAt: s('When.', { format: 'date-time' }),
})
const SESSION_VIEW = {
  ...SESSION,
  properties: {
    ...(SESSION.properties as Schema),
    day: nul(s('The day of the session a key gets by writing without opening one.', { format: 'date' })),
    client: nul(s('What wrote: web, the agent of a short key, the app of a connection, or a program.')),
    author: NAMED,
    entries: n('Its active entries, the summary aside.'),
    forgotten: n('Its entries forgotten since (not counted in "entries").'),
    summary: nul(s('Its summary (the first 300 characters), once closed with one.')),
  },
  required: [...(SESSION.required as string[]), 'day', 'client', 'author', 'entries', 'forgotten', 'summary'],
}
const ENTRY_LIST = obj({
  items: list({
    ...ENTRY,
    properties: { ...(ENTRY.properties as Schema), conflict: b('An open conflict is about it.') },
    required: [...(ENTRY.required as string[]), 'conflict'],
  }),
  total: n('How many.'),
  next: NEXT,
})
// The session an entry is in, named by its purpose (the session of a day has its day instead).
const SESSION_REF = obj({
  id: s('Session id.'),
  purpose: s('What it was for; "implicit" for the session of a day.'),
  day: nul(s('The day of the session a key gets by writing without opening one.', { format: 'date' })),
})
// A side of a conflict: the entry, who wrote it and with what, and its session.
const CONFLICT_SIDE = {
  ...ENTRY_READ,
  properties: { ...(ENTRY_READ.properties as Schema), session: SESSION_REF },
  required: [...ENTRY_READ.required, 'session'],
}
const ENTRY_LIST_READ = obj({ items: list(ENTRY_READ), total: n('How many.'), next: NEXT })
const ENTRY_IN = obj(
  {
    type: s('decision, learning, attempt, preference, fact, step, summary or note.'),
    title: s('A short title.', { maxLength: 260 }),
    content: s('The entry. Private parts in <private>…</private>.', { maxLength: 32000 }),
    topic: s('A topic key; saving the same topic revises it.'),
    appliesTo: s('Who or what it applies to.'),
    tags: list(s('A tag.')),
    refs: list(s('A file, link or id.')),
    reviewAfter: s('A day to review it.', { format: 'date' }),
    expiresAt: s('A day after which it no longer holds.', { format: 'date' }),
    sessionId: s('The session it belongs to.'),
    requestKey: s('Repeating the request with the same key returns the same receipt.'),
  },
  ['topic', 'appliesTo', 'tags', 'refs', 'reviewAfter', 'expiresAt', 'sessionId', 'requestKey'],
)
const RECEIPT = obj({
  entryId: s('The entry written or revised.'),
  revision: n('Its revision.'),
  at: s('When.', { format: 'date-time' }),
  deduplicated: b('The same entry was already there: nothing new was written.'),
  repeatCount: n('How many times it was saved.'),
  redactions: n('How many secrets were struck out.'),
  similar: list({ type: 'object' }, 'Similar entries to look at.'),
})
const HIT = obj(
  {
    kind: s('entry or page.'),
    id: s('Its id.'),
    address: s('A page: its address.'),
    brain: s('Its brain (slug).'),
    type: s('Its type (an entry type, or a page type).'),
    state: s('An entry: active, forgotten…; a page: current, stale or superseded.'),
    title: s('Title.'),
    snippet: s('Where it matched.'),
    why: s('Why it is here: words, meaning, recent or link.', {
      enum: ['words', 'meaning', 'recent', 'link'],
    }),
    reason: s('The same, in words.'),
    at: s('When it was written or changed.', { format: 'date-time' }),
  },
  ['address'],
)
export const EVENT = obj(
  {
    id: s('The event id: send it back as Last-Event-ID to resume.'),
    at: s('When.', { format: 'date-time' }),
    brain: s('The brain (slug).'),
    kind: s(
      'session.opened, session.closed, entry.saved, entry.revised, entry.repeated, entry.changed, search, read, proposal.submitted, proposal.withdrawn, proposal.decided, wiki.changed; and gap.',
    ),
    who: nul(obj({ id: s('Account id.'), name: s('Account name.') })),
    key: nul(obj({ id: s('Credential id.'), ref: nul(s('The external reference of a short key.')) })),
    target: nul(obj({ id: s('What it touches.'), label: nul(s('Its title or address.')) })),
    query: nul(s('For a search: the text searched, already redacted.')),
    client: nul(
      s('What did it: web, the agent of a short key, the app of a connection, or a program (G13).'),
    ),
    sessionRef: nul(s('The external reference of the session it happened in.')),
    onBehalf: nul(obj({ id: s('Account id.'), name: s('Account name.') })),
    summaryEntryId: nul(
      s('For session.closed: the summary entry whose title is the label (a forget of it hides the title).'),
    ),
  },
  [],
)
const PAGE = obj({ items: list({ type: 'object' }), next: NEXT })

// Proposals as the inbox of the web reads and decides them (spec B2 «Revisar una propuesta», B6 PR21).
const PROPOSAL_STATUS = s('pending, approved, partially_approved, returned, withdrawn or superseded.', {
  enum: ['pending', 'approved', 'partially_approved', 'returned', 'withdrawn', 'superseded'],
})
const PROPOSAL = obj(
  {
    id: s('Proposal id (prp_…).'),
    brainId: s('Its brain.'),
    title: s('What it changes.'),
    reason: s('Why.'),
    authorId: s('The account that proposed.'),
    authorName: s('Its name.'),
    agent: nul(s('The agent or program that wrote it, as it named itself.')),
    status: PROPOSAL_STATUS,
    old: b('Pending for more than 30 days.'),
    supersedes: nul(s('The proposal it replaced.')),
    supersededBy: nul(s('The proposal that replaced it.')),
    collected: list(s('Entry id.'), 'Entries it gathers without changes.'),
    comment: nul(s('The curator’s comment on what went back.')),
    decidedBy: nul(s('The curator who decided.')),
    decidedByName: nul(s('Their name.')),
    decidedAt: nul(s('When.', { format: 'date-time' })),
    lastError: nul(s('Why the last approval could not apply.')),
    createdAt: s('When it was sent.', { format: 'date-time' }),
    purged: b('Its texts were purged.'),
  },
  ['authorName', 'decidedByName'],
)
const PROPOSAL_NAMED = {
  ...PROPOSAL,
  required: [...(PROPOSAL.required as string[]), 'authorName', 'decidedByName'],
}
const PROPOSAL_COUNTS = obj(
  Object.fromEntries(
    ['pending', 'approved', 'partially_approved', 'returned', 'withdrawn', 'superseded'].map((k) => [
      k,
      n(`Proposals ${k.replace('_', ' ')}.`),
    ]),
  ),
)
const INBOX = obj(
  {
    items: list(
      {
        ...PROPOSAL_NAMED,
        properties: { ...(PROPOSAL.properties as Schema), opCount: n('Its operations.') },
        required: [...PROPOSAL_NAMED.required, 'opCount'],
      },
      'Newest first.',
    ),
    next: NEXT,
    total: n('How many in this status.'),
    counts: PROPOSAL_COUNTS,
  },
  ['counts'],
)
const WARNING = obj({
  op: nul(n('The operation it is about; null for the whole proposal.')),
  code: s('A stable code.'),
  message: s('What to look at.'),
})
const OP_STATUS = s('pending, approved or returned.', { enum: ['pending', 'approved', 'returned'] })
const PROPOSAL_OP = obj(
  {
    index: n('Its number in the proposal, from 0.'),
    op: {
      type: 'object',
      description: 'The operation (create, edit, move, link, unlink, status, merge or revert).',
    },
    status: OP_STATUS,
    correctedBy: nul(s('The curator who corrected it before approving.')),
    baseReviewedBy: nul(s('The curator who marked its old base reviewed.')),
    appliedPage: nul(s('The page it changed.')),
    appliedRevision: nul(n('The revision it made.')),
  },
  ['correctedBy', 'baseReviewedBy', 'appliedPage', 'appliedRevision'],
)
const PAGE_STATE = {
  type: ['object', 'null'],
  description:
    'The page: address, revision, type, title, summary, body, tags, status, sources, links, mentions.',
}
const REVIEW = obj({
  proposal: PROPOSAL_NAMED,
  fingerprint: s('The version seen: approving and returning send it back.'),
  ops: list(
    obj({
      index: n('Its number, from 0.'),
      op: { type: 'object', description: 'The operation as proposed.' },
      status: OP_STATUS,
      corrected: b('A curator corrected it.'),
      before: PAGE_STATE,
      after: PAGE_STATE,
      dependsOn: list(n('Operation number.'), 'The operations it cannot be approved without.'),
      stale: {
        type: ['object', 'null'],
        description:
          'An edit written on an older revision: base (the revision it was written on), current and proposed. Approving it needs a correction or "base reviewed".',
      },
      warnings: list(WARNING),
    }),
  ),
  warnings: list(WARNING, 'About the whole proposal.'),
  canDecide: b('Whether you may approve or return it (a curator of an active brain, in the web).'),
  purges: n('How many times text was purged from this wiki; a correction echoes it.'),
})
const DECISION = obj({
  proposal: PROPOSAL_NAMED,
  ops: list(PROPOSAL_OP),
  applied: list(
    obj(
      {
        index: n('The operation.'),
        pageId: s('The page changed.'),
        address: s('Its address now.'),
        revision: n('The revision made.'),
      },
      ['index'],
    ),
    'The pages that changed.',
  ),
})

// The wiki as a person reads and edits it in the web (spec B2, B6 PR19).
const PAGE_TYPE = s('topic, entity, decision, guide, agent, source or overview.', {
  enum: ['topic', 'entity', 'decision', 'guide', 'agent', 'source', 'overview'],
})
const PAGE_STATUS = s('current, stale, superseded or retired.', {
  enum: ['current', 'stale', 'superseded', 'retired'],
})
const WIKI_PAGE = obj({
  id: s('Page id.'),
  brainId: s('Its brain.'),
  address: s('Its current address.'),
  type: PAGE_TYPE,
  title: s('Title.'),
  summary: s('One sentence.'),
  body: s('Markdown; [[address]] mentions another page.'),
  tags: list(s('Tag.')),
  status: PAGE_STATUS,
  supersededBy: nul(s('The page that replaces it, when superseded.')),
  revision: n('Its current revision: edit against it.'),
  createdAt: s('When.', { format: 'date-time' }),
  updatedAt: s('When it last changed.', { format: 'date-time' }),
})
const LINK_VIEW = obj({
  kind: s('mentions, related, depends-on, contradicts, supersedes, part-of or example-of.'),
  address: s('The other page.'),
  pageId: nul(s('Its id; null when no page has that address (a broken link).')),
  title: nul(s('Its title.')),
  state: s('ok, broken, stale, retired or superseded.', {
    enum: ['ok', 'broken', 'stale', 'retired', 'superseded'],
  }),
})
const SOURCE_VIEW = obj(
  {
    entryId: s('A journal entry it comes from.'),
    url: s('An external address it comes from.'),
    title: nul(s('Title; null for an entry forgotten or purged since.')),
    state: s('active, forgotten or purged (entries only).'),
  },
  ['entryId', 'url', 'state'],
)
const PAGE_CORRECTION = obj({
  id: s('The correction (an entry).'),
  title: s('Its title.'),
  appliesTo: nul(s('The agent it is for; null for every agent.')),
  author: NAMED,
  createdAt: s('When.', { format: 'date-time' }),
})
const PAGE_READING = obj(
  {
    page: WIKI_PAGE,
    redirectedFrom: s('The old address asked for.'),
    notice: s('Why it should be read with care (retired, superseded).'),
    links: obj({ out: list(LINK_VIEW), in: list(LINK_VIEW) }),
    sources: list(SOURCE_VIEW),
    lastChange: nul(
      obj({
        revision: n('The revision the page is at.'),
        authorId: s('Who saved it.'),
        authorName: s('Their name.'),
        at: s('When.', { format: 'date-time' }),
      }),
    ),
    corrections: list(PAGE_CORRECTION),
  },
  ['redirectedFrom', 'notice'],
)
const REVISION_SUMMARY = {
  revision: n('Its number.'),
  address: s('The address it had.'),
  title: s('The title it had.'),
  status: PAGE_STATUS,
  kind: s('proposal, direct, revert or purge.'),
  change: s('What it changed: created, edited, linked, status, moved or restored.', {
    enum: ['created', 'edited', 'linked', 'status', 'moved', 'restored'],
  }),
  restoredFrom: nul(n('The revision it restored.')),
  reason: nul(s('Why: the curator’s reason, or the operation’s for a proposal.')),
  authorId: s('Who made it.'),
  authorName: s('Their name.'),
  proposalId: nul(s('The proposal it came from.')),
  corrected: b('A curator corrected the operation before approving.'),
  baseReviewed: b('Approved on a base that had moved on, after review.'),
  purged: nul({ type: 'object', description: 'Who purged its text, when and why.' }),
  createdAt: s('When.', { format: 'date-time' }),
}
const FULL_REVISION = obj({
  ...REVISION_SUMMARY,
  type: PAGE_TYPE,
  summary: s('Summary it had.'),
  body: s('Body it had.'),
  tags: list(s('Tag.')),
  sources: list({ type: 'object' }, 'Its sources then.'),
  links: list({ type: 'object' }, 'Its typed links then.'),
})
const CHANGED = obj({
  revised: list(
    obj({ pageId: s('Page.'), address: s('Its address now.'), revision: n('Its new revision.') }, []),
  ),
  page: nul(PAGE_READING),
})

const ACCOUNT_SIGNED_IN = obj({
  id: s('Account id.'),
  name: s('Name.'),
  email: s('Email.'),
  isAdmin: b('An administrator of the installation.'),
})

const HAND: Record<string, Op> = {
  'GET /v1/brains/{slug}/wiki/pages': {
    summary:
      'The pages of a wiki by pages, in address order or as sorted, with how many pages link in and out.',
    query: {
      q: 'Part of the address or the title.',
      prefix: 'Only pages under this first part of the address.',
      loose:
        '1: only the pages at the level of prefix (the top without one) with no deeper part, as the graph gathers them.',
      type: 'Only this page type.',
      status:
        'Only these statuses: one or more of current, stale, superseded and retired, separated by commas.',
      tag: 'Only pages with this tag.',
      linkKind:
        'Only pages with a link of this kind, either way: mentions, related, depends-on, contradicts, supersedes, part-of or example-of.',
      sort: 'address (the default), title, type, status, in, out or updatedAt; "-" before it for the other way.',
      cursor: 'The "next" of the previous page.',
      limit: 'Pages per answer.',
    },
    reply: obj({
      items: list(
        obj({
          address: s('Address.'),
          title: s('Title.'),
          type: PAGE_TYPE,
          status: PAGE_STATUS,
          tags: list(s('Tag.')),
          in: n('Pages linking to it.'),
          out: n('Pages it links to.'),
          updatedAt: s('When it last changed.', { format: 'date-time' }),
        }),
      ),
      next: NEXT,
      total: n('Pages that match, on every page of the answer.'),
    }),
  },
  'GET /v1/brains/{slug}/wiki/graph': {
    summary:
      'The graph of a wiki: a node a page and an edge a link, retired pages left out. Up to 2 000 pages it comes whole; above that, as groups one part of the address deeper; prefix opens one group (a group above 2 000 opens by groups again). The filters narrow what is counted and drawn, never whether it comes as pages or groups. Sent gzipped when big and accepted.',
    query: {
      prefix: 'Open this group: the pages whose address starts with it (one or more parts).',
      loose:
        '1 opens the pages gathered at this level (the group marked loose): pages with no deeper part of their own.',
      q: 'Only pages with these words in the title or the address.',
      type: 'Only this page type.',
      status: 'Only these statuses, separated by commas.',
      tag: 'Only pages with this tag.',
      linkKind: 'Only pages with a link of this kind, either way, and only those links.',
    },
    reply: obj({
      mode: s(
        'pages (nodes and edges), groups (the wiki is too big: groups and the links between them) or too-big (this group cannot be drawn: use the list).',
        {
          enum: ['pages', 'groups', 'too-big'],
        },
      ),
      prefix: nul(s('The group opened, or null for the whole wiki.')),
      total: n('Pages this answer stands for, retired ones left out.'),
      kinds: list(s('Link kind.'), 'The link kinds, in the order edges name them by index.'),
      nodes: list(
        { type: 'array', prefixItems: [s('Address.'), s('Title.'), PAGE_TYPE, PAGE_STATUS, list(s('Tag.'))] },
        'Pages in address order: [address, title, type, status, tags].',
      ),
      edges: list(
        { type: 'array', prefixItems: [n('From node.'), n('To node.'), n('Kind index.')] },
        'Links between nodes: [from, to, kind] by index.',
      ),
      across: list(
        { type: 'array', prefixItems: [n('Node.'), s('Other group.'), n('Links.')] },
        'In one group: [node, other group, links both ways].',
      ),
      groups: list(
        obj(
          {
            prefix: s('The address the group is under (the level itself, "" at the top, for a loose group).'),
            count: n('Pages in it.'),
            types: {
              type: 'object',
              description: 'Pages in it by type.',
              additionalProperties: { type: 'integer' },
            },
            loose: {
              type: 'boolean',
              enum: [true],
              description:
                'The pages of this level with no deeper part, gathered when they are more than 50 (open with loose=1).',
            },
          },
          ['loose'],
        ),
        'The groups of the wiki; in one group, the other groups its pages link with. A page with no deeper part is a node beside the groups.',
      ),
      groupEdges: list(
        { type: 'array', prefixItems: [s('Group.'), s('Group.'), n('Links.')] },
        'Links between groups: [group, group, links both ways].',
      ),
    }),
  },
  'GET /v1/brains/{slug}/wiki/map': {
    summary:
      'The map: every current page by type and first part of its address, with its summary; status=all for every page whatever its status.',
    query: { status: '"all" for every status; left out, current pages only.' },
    reply: obj({
      intro: s('The curators’ introduction.'),
      groups: list(
        obj({
          type: PAGE_TYPE,
          area: s('First part of the address.'),
          pages: list(
            obj({
              address: s('Address.'),
              title: s('Title.'),
              summary: s('Summary.'),
              tags: list(s('Tag.')),
              status: PAGE_STATUS,
            }),
          ),
        }),
      ),
      count: n('Pages on the map.'),
    }),
  },
  'GET /v1/brains/{slug}/wiki/decisions': {
    summary: 'The decision pages, newest first, with their status (retired ones left out).',
    reply: obj({
      decisions: list(
        obj({
          address: s('Address.'),
          title: s('Title.'),
          summary: s('Summary.'),
          status: PAGE_STATUS,
          createdAt: s('When it was decided.', { format: 'date-time' }),
          updatedAt: s('When it last changed.', { format: 'date-time' }),
        }),
      ),
    }),
  },
  'GET /v1/brains/{slug}/wiki/health': {
    summary:
      'The checks of the wiki (no AI): orphans, broken links, conflicts, stale pages, sources no longer available, long pages, titles almost the same; and whether a maintenance proposal is due.',
    reply: (() => {
      const ref = obj({ address: s('The page.'), title: s('Its title.') })
      const pair = obj({
        a: s('One page.'),
        aTitle: s('Its title.'),
        b: s('The other.'),
        bTitle: s('Its title.'),
      })
      return obj({
        orphans: list(ref),
        broken: list(
          obj({
            from: s('The page with the link.'),
            fromTitle: s('Its title.'),
            to: s('The address it links to.'),
          }),
        ),
        conflicts: list(pair),
        stale: list(
          obj({
            address: s('The page.'),
            title: s('Its title.'),
            updatedAt: s('When it last changed.', { format: 'date-time' }),
            newEntries: n('Entries about it written since.'),
          }),
        ),
        unavailableSources: list(
          obj({
            address: s('The page.'),
            title: s('Its title.'),
            entryId: s('The source entry.'),
            state: s('forgotten or purged.', { enum: ['forgotten', 'purged'] }),
          }),
        ),
        long: list(obj({ address: s('The page.'), title: s('Its title.'), chars: n('Its length.') })),
        similarTitles: list(pair),
        maintenance: obj({
          suggested: b('A maintenance proposal is due.'),
          approvalsSince: n('Approvals since the last one.'),
          every: n('Every how many approvals.'),
        }),
      })
    })(),
  },
  'GET /v1/brains/{slug}/wiki/log': {
    summary: 'One line per change applied to the wiki, newest first.',
    query: {
      kind: 'proposal, direct, revert or purge.',
      page: 'Only lines that touched this address.',
      cursor: 'The "next" of the previous page.',
      limit: 'Lines per answer.',
    },
    reply: obj({
      items: list(
        obj({
          id: s('Line id.'),
          at: s('When.', { format: 'date-time' }),
          actorId: s('Who.'),
          actorName: s('Their name.'),
          kind: s('proposal, direct, revert or purge.', { enum: ['proposal', 'direct', 'revert', 'purge'] }),
          proposalId: nul(s('The proposal it applied.')),
          summary: s('What changed.'),
          reason: nul(s('Why: the curator’s reason, or the proposal’s.')),
          pages: list(s('Address.')),
        }),
      ),
      next: NEXT,
      total: n('Lines that match.'),
    }),
  },
  'GET /v1/brains/{slug}/pages/{address}': {
    summary:
      'A page by its address (an old address leads to it), with its links both ways and its sources; history=1 for its revisions, revision=N for one, compare=A,B for two.',
    query: {
      history: '1 for its revisions.',
      revision: 'One revision.',
      compare: 'Two revisions, e.g. 3,5.',
      include: '"history" for the page and its revisions in one read.',
    },
    reply: obj(
      {
        ...(PAGE_READING.properties as Record<string, Schema>),
        history: list(obj(REVISION_SUMMARY)),
        revision: FULL_REVISION,
        a: FULL_REVISION,
        b: FULL_REVISION,
      },
      [
        'page',
        'redirectedFrom',
        'notice',
        'links',
        'sources',
        'lastChange',
        'corrections',
        'history',
        'revision',
        'a',
        'b',
      ],
    ),
  },
  'PATCH /v1/brains/{slug}/pages/{address}': {
    summary:
      'A curator edits a page by hand in the web, against the revision read (baseRevision). A page that moved on answers 409 page_changed with the current version in "current".',
    body: obj(
      {
        baseRevision: n('The revision the edit was made on.'),
        type: PAGE_TYPE,
        title: s('Title.'),
        summary: s('Summary.'),
        body: s('Markdown body.'),
        tags: list(s('Tag.')),
        sources: list({ type: 'object' }, 'Its sources: {entryId} or {url, title}.'),
        reason: s('Why.'),
      },
      ['type', 'title', 'summary', 'body', 'tags', 'sources', 'reason'],
    ),
    reply: CHANGED,
  },
  'POST /v1/brains/{slug}/wiki/changes': {
    summary:
      'A curator changes the wiki by hand in the web: one operation (create, edit, move, link, unlink, status, merge or revert), checked like a proposal.',
    status: 201,
    reply: CHANGED,
  },
  'GET /v1/branding': {
    summary:
      'The name and logo of the installation, and whether the first-time setup is still to do (no key; answers before the setup).',
    reply: obj({
      name: s('The name of the installation; empty until the first-time setup.'),
      logo: nul({
        ...obj({
          url: s('Where the logo is (GET /v1/branding/logo).'),
          updatedAt: s('When it last changed.', { format: 'date-time' }),
        }),
        type: ['object', 'null'],
      }),
      setupRequired: b('The first-time setup is still to do: the web leads to it.'),
      canSendMail: b(
        'The installation can send email (reset links, invitations); without it an administrator makes reset links by hand.',
      ),
    }),
  },
  'GET /v1/branding/logo': {
    summary: 'The logo of the installation (no key). 404 no_logo when there is none.',
    image: true,
  },
  'GET /v1/setup': {
    summary: 'Whether the first-time setup can run from this connection (404 setup_done once done).',
    query: { publicUrl: 'The address you are about to give, to warn if it is not safe.' },
    reply: obj({
      done: b('Always false: once done, this answers 404.'),
      connection: obj({ encrypted: b('Over TLS.'), local: b('From this machine.') }),
      warning: nul(s('Why the address would be unsafe for passwords.')),
    }),
  },
  'POST /v1/setup': {
    summary: 'The first-time setup (the rsc-brain web only): name, address and the first administrator.',
    status: 201,
    body: obj({
      name: s('The name of the installation.', { maxLength: 80 }),
      publicUrl: s('The address people open.'),
      admin: obj({ name: s('Your name.'), email: s('Your email.'), password: s('12 to 200 characters.') }),
    }),
    reply: obj({
      done: b('True.'),
      publicUrl: s('The address, as stored.'),
      warning: nul(s('Why the address is unsafe for passwords, if it is.')),
      adminId: s('The administrator account.'),
    }),
  },
  'POST /v1/auth/login': {
    summary: 'Sign in to the web (the rsc-brain web only): sets the session cookie.',
    body: obj(
      { email: s('Email.'), password: s('Password.'), code: s('The 6 digits of the authenticator app.') },
      ['code'],
    ),
    reply: obj({ account: ACCOUNT_SIGNED_IN }),
  },
  'POST /v1/auth/logout': {
    summary: 'Sign out of this web session.',
    reply: obj({ signedOut: b('True.') }),
  },
  'POST /v1/auth/reset': {
    summary:
      'Ask for a password reset link by email; the answer is the same whether the email exists or not.',
    status: 202,
    body: obj({ email: s('Email.') }),
    reply: obj({ message: s('What happens next.') }),
  },
  'POST /v1/auth/reset/look': {
    summary:
      'Whether a reset link still works, without spending it (the token travels in the body). Names no account.',
    body: obj({ token: s('The token after #token= in the link.') }),
    reply: obj({ valid: b('True; a link that does not work is refused with link_invalid.') }),
  },
  'POST /v1/auth/reset/confirm': {
    summary: 'Choose a new password with the token of a reset link.',
    body: obj({ token: s('The token after #token= in the link.'), password: s('12 to 200 characters.') }),
    reply: obj({ reset: b('True.') }),
  },
  'POST /v1/invitations/look': {
    summary: 'What an invitation offers, before accepting it (the token travels in the body).',
    body: obj({ token: s('The token after #token= in the link.') }),
    reply: obj({
      invitation: obj({
        email: s('Who it is for.'),
        installation: s('The name of the installation.'),
        brains: list(obj({ slug: s('Slug.'), name: s('Name.'), role: s('reader, contributor or curator.') })),
        isAdmin: b('It makes you an administrator.'),
        expiresAt: s('Until when it works.', { format: 'date-time' }),
      }),
    }),
  },
  'POST /v1/invitations/accept': {
    summary: 'Accept an invitation (the rsc-brain web only): your account, your roles and a web session.',
    status: 201,
    body: obj({ token: s('The token.'), name: s('Your name.'), password: s('12 to 200 characters.') }),
    reply: obj({
      account: ACCOUNT_SIGNED_IN,
      brains: list(
        obj({ slug: s('Slug.'), name: s('Name.'), role: s('reader, contributor or curator.') }),
        'The brains you joined, with your role in each.',
      ),
    }),
  },
  'GET /v1/health': { summary: 'Whether the server answers.', reply: obj({ ok: b('Always true.') }) },
  'GET /v1/openapi.json': { summary: 'This description.', reply: { type: 'object' } },
  'GET /v1/me': {
    summary: 'Who this key is, what it may do, and the installation.',
    reply: obj({
      account: obj({
        id: s('Account id.'),
        kind: s('person or service.'),
        name: s('Name.'),
        email: nul(s('Email.')),
        isAdmin: b('Administration rights travel with this key.'),
        canCreateBrains: b('This key may create brains.'),
        canInvite: b(
          'This key may invite people (POST /v1/invitations): a web session of the administration, or of a curator when the installation allows curators to invite.',
        ),
        totp: nul(b('The account signs in with a second factor; null for any key but a web session.')),
      }),
      installation: obj({
        name: s('The name of the installation.'),
        factoryUrl: nul(s('The address of RSC Factory, when the administration set one.')),
      }),
      key: obj({
        id: s('Credential id.'),
        kind: s('web, token, app, main or short.'),
        perm: s('read or write.'),
        ref: nul(s('External reference of a short key.')),
        agent: nul(s('Agent of a short key.')),
      }),
    }),
  },
  'POST /v1/me/tokens': {
    summary:
      'Create a personal token (the rsc-brain web only): read or read + write, for some brains or all, for 30, 90 or 365 days. The secret is shown only in this answer.',
    status: 201,
    body: obj(
      {
        name: s('What it is for, such as "Claude Code laptop".'),
        perm: s('read, or write (read + write).'),
        brains: list(s('The name of a brain.'), 'The brains it reaches.'),
        allBrains: b('Every brain you are a member of, including brains you join later.'),
        days: n('30, 90 or 365 (90 by default).'),
      },
      ['brains', 'allBrains', 'days'],
    ),
    reply: obj(
      {
        token: obj({
          id: s('Credential id.'),
          secret: s('The token. Shown only here.'),
          last4: s('Its last four characters, to recognise it later.'),
          expiresAt: s('When it ends.', { format: 'date-time' }),
        }),
        message: s('A reminder that it is shown once.'),
        note: s('Said when it reaches every brain.'),
      },
      ['note'],
    ),
  },
  'GET /v1/brains': { summary: 'The brains this key can use.', reply: obj({ brains: list(BRAIN_ROLE) }) },
  'POST /v1/brains': {
    summary: 'Create a brain (with the right to create brains).',
    status: 201,
    body: obj(
      {
        slug: s('Its name: lowercase letters, digits and hyphens.'),
        name: s('Display name.'),
        purpose: s('What it is for.'),
        description: s('More about it.'),
        firstCurator: s('For a service account: the email of its first curator.'),
      },
      ['name', 'purpose', 'description', 'firstCurator'],
    ),
    reply: obj({ brain: BRAIN }),
  },
  'GET /v1/brains/{slug}': { summary: 'One brain.', reply: obj({ brain: BRAIN_ROLE }) },
  'GET /v1/brains/{slug}/overview': {
    summary:
      "A brain at a glance: its numbers, today's sessions, the newest pending proposals, health counts and the first steps of a new brain.",
    reply: obj({
      cursor: s(
        'The id of the newest event this answer already shows. Follow the brain from here: GET /v1/brains/{slug}/events with Last-Event-ID set to it replays whatever came after.',
      ),
      stats: STATS,
      todaySessions: list(
        obj({
          id: s('Session id.'),
          who: s('The account that opened it.'),
          client: nul(s('The agent or app of its key.')),
          purpose: s('What it is for.'),
          ref: nul(s('External reference.')),
          status: s('open, closed or closed_no_summary.'),
          entries: n('Entries written in it (its summary aside).'),
          summary: nul(s('The start of its summary, once closed with one.')),
          openedAt: s('When.', { format: 'date-time' }),
          lastActivityAt: s('Last write.', { format: 'date-time' }),
        }),
        'Sessions active today in the time zone of the installation, newest first (at most 20).',
      ),
      pending: list(
        obj({
          id: s('Proposal id.'),
          title: s('What it changes.'),
          agent: nul(s('The agent that sent it.')),
          opCount: n('Its operations.'),
          old: b('Pending for a long time.'),
          createdAt: s('When.', { format: 'date-time' }),
        }),
        'The newest pending proposals (at most 5).',
      ),
      health: obj({
        orphans: n('Pages nothing links to.'),
        broken: n('Links to pages that do not exist.'),
        conflicts: n('Pages linked as contradicting.'),
        stale: n('Old pages the journal keeps mentioning.'),
        unavailableSources: n('Sources forgotten or purged.'),
        long: n('Pages past the length threshold.'),
        similarTitles: n('Pairs of almost equal titles.'),
      }),
      firstSteps: obj({
        agentConnected: b('A key that is not a web session opened a session or proposed here.'),
        firstEntry: b('The journal has an entry.'),
        imported: b('A folder was imported (always false until importing exists).'),
      }),
    }),
  },
  'POST /v1/invitations': {
    summary:
      'Invite people by email (the rsc-brain web only): the administration anywhere; a curator, when allowed, to brains they curate.',
    status: 201,
    body: obj(
      {
        emails: list(s('An email.'), '1 to 50 emails.'),
        brains: list(obj({ slug: s('Slug.'), role: s('curator, contributor or reader.') })),
        isAdmin: b('Also an administrator (administration only).'),
        canCreateBrains: b('May create brains (administration only).'),
      },
      ['brains', 'isAdmin', 'canCreateBrains'],
    ),
    reply: obj({ invitations: list(INVITED) }),
  },
  'GET /v1/invitations': {
    summary: 'Invitations: all of them for the administration; a curator sees the ones they sent.',
    reply: obj({
      invitations: list(
        obj({
          id: s('Invitation id.'),
          email: s('Who it is for.'),
          status: s('pending, expired, used or revoked.', {
            enum: ['pending', 'expired', 'used', 'revoked'],
          }),
          brains: list(obj({ slug: s('Slug.'), role: s('Role.') })),
          isAdmin: b('It makes an administrator.'),
          invitedBy: s('Who sent it.'),
          createdAt: s('When.', { format: 'date-time' }),
          expiresAt: s('Until when it works.', { format: 'date-time' }),
        }),
      ),
    }),
  },
  'POST /v1/invitations/{id}/resend': {
    summary: 'A new link for a pending invitation (the old one stops working), sent again.',
    reply: obj({ invitation: INVITED }),
  },
  'DELETE /v1/invitations/{id}': {
    summary: 'Withdraw an invitation that was not used.',
    reply: obj({ revoked: s('The invitation id.') }),
  },
  'GET /v1/admin/accounts': {
    summary: 'People and service accounts of the installation (administration).',
    reply: obj({
      accounts: list(
        obj({
          id: s('Account id.'),
          kind: s('person or service.'),
          name: s('Name.'),
          email: nul(s('Email (people).')),
          isAdmin: b('An administrator.'),
          canCreateBrains: b('May create brains.'),
          status: s('active or removed.'),
          brains: n('Brains it is a member of.'),
          lastSeenAt: nul(s('Last use of any of its keys.', { format: 'date-time' })),
          createdAt: s('When.', { format: 'date-time' }),
        }),
      ),
    }),
  },
  'POST /v1/admin/accounts/{id}/reset-link': {
    summary:
      'A password reset link for a person, to give by hand (the rsc-brain web only, administration). Works once, for 1 hour.',
    status: 201,
    reply: obj({
      link: s('The single-use link. Shown only in this answer.'),
      expiresAt: s('Until when it works.', { format: 'date-time' }),
    }),
  },
  'GET /v1/admin/brains': {
    summary: 'Every brain of the installation, without its content (administration).',
    reply: obj({
      brains: list(
        obj({
          slug: s('Slug.'),
          name: s('Name.'),
          status: s('active or archived.'),
          members: n('How many members.'),
          curators: list(obj({ id: s('Account id.'), name: s('Name.') })),
          pendingCurator: nul({
            ...obj({ email: s('Email invited as first curator.'), invitationId: nul(s('Its invitation.')) }),
            type: ['object', 'null'],
          }),
          youAreMember: b('You are a member (only members read it).'),
        }),
      ),
    }),
  },
  'POST /v1/brains/{slug}/sessions': {
    summary: 'Open a session (a service: for one of its short keys, with forKey).',
    status: 201,
    body: obj(
      { purpose: s('What it is for.'), ref: s('External reference.'), forKey: s('A short key id.') },
      ['purpose', 'ref', 'forKey'],
    ),
    reply: obj({ session: SESSION }),
  },
  'GET /v1/brains/{slug}/members': {
    summary: 'The members of a brain with their roles, and who wrote here and is no longer a member.',
    reply: obj({
      members: list(
        obj(
          {
            accountId: s('Account id.'),
            kind: s('person or service.'),
            name: s('Name.'),
            email: nul(s('Their email, for curators only.')),
            role: s('reader, contributor or curator.'),
            notifyProposals: b('Your own choice of mail for new proposals (only on your line).'),
          },
          ['notifyProposals'],
        ),
      ),
      former: list(obj({ accountId: s('Account id.'), name: s('Name.'), label: s('former member') })),
      pendingCurator: {
        description: 'The email invited as first curator (curators), or whether there is one.',
      },
    }),
  },
  'GET /v1/brains/{slug}/sessions': {
    summary: 'Sessions of a brain, newest first, with their client, author, entries and summary; filtered.',
    query: {
      status: 'open, closed or closed_no_summary.',
      client: 'The client, as the "clients" of facets name them.',
      author: 'An account id.',
      ref: 'Part of an external reference (the session’s, or one stamped on its entries).',
      type: 'Sessions with an entry of this type.',
      from: 'Active on or after this day (or ISO instant).',
      to: 'Opened on or before this day (or ISO instant).',
      uncompiled: '1 for sessions with entries no proposal has gathered yet.',
      cursor: 'The "next" of the previous page.',
      limit: 'At most this many (1–200).',
    },
    reply: obj(
      {
        items: list(SESSION_VIEW),
        total: n('How many match the filters.'),
        next: NEXT,
        liveFrom: s('The newest event already in this answer: follow the live events from here.'),
        facets: obj({ clients: list(s('A client.')), authors: list(NAMED) }),
      },
      ['facets'],
    ),
  },
  'GET /v1/sessions/{id}': {
    summary: 'One session, with its client, author, entries and summary.',
    reply: obj({ session: SESSION_VIEW }),
  },
  'GET /v1/me/sessions': {
    summary:
      'The open sessions of this key, with their brain (API only: the reminder at the end of an agent session asks it).',
    reply: obj({
      items: list({
        ...SESSION,
        properties: { ...(SESSION.properties as Schema), brain: s('The slug of its brain.') },
        required: [...(SESSION.required as string[]), 'brain'],
      }),
    }),
  },
  'GET /v1/connect': {
    summary:
      'The connection kit: per agent, the standard sign-in, a config block with a token placeholder (never a secret), the optional reminder and the check.',
    query: {
      agent: 'Only this agent: claude-code, codex, opencode, cursor or other.',
      brain: 'Name this brain in the check and the start hook.',
    },
    reply: obj({
      mcpUrl: s('The MCP address of this installation.'),
      tokenEnv: s('The environment variable the config blocks read the token from.'),
      tokenPlaceholder: s('The text in the blocks that the token replaces.'),
      agents: list(
        obj({
          id: s('claude-code, codex, opencode, cursor or other.'),
          name: s('Display name.'),
          signIn: nul({
            type: 'object',
            description: 'Connecting with the standard sign-in (only the address).',
          }),
          token: { type: 'object', description: 'Connecting with a token: a note and config blocks.' },
          reminder: nul({
            type: 'object',
            description: 'The optional reminder: hooks, or a prompt and instructions text.',
          }),
          check: s('How to check that it works.'),
        }),
      ),
    }),
  },
  'POST /v1/brains/{slug}/entries': {
    summary: 'Save an entry; returns its receipt.',
    status: 201,
    body: ENTRY_IN,
    reply: obj({ receipt: RECEIPT }),
  },
  'GET /v1/entries/{id}': {
    summary: 'One entry with who wrote it and its relations (history=1 for its revisions).',
    query: { history: '1 for its revisions.' },
    reply: obj(
      {
        entry: ENTRY_READ,
        session: SESSION_REF,
        relations: list(ENTRY_RELATION),
        history: list(
          obj({
            revision: n('Its number.'),
            type: s('Type.'),
            title: s('Title.'),
            content: s('Content.'),
            appliesTo: nul(s('Who it applies to.')),
            tags: list(s('A tag.')),
            refs: list(s('A reference.')),
            authorId: s('Who wrote it.'),
            authorName: s('Their name.'),
            createdAt: s('When.', { format: 'date-time' }),
          }),
        ),
      },
      ['history'],
    ),
  },
  'GET /v1/brains/{slug}/entries': {
    summary: 'Entries of a brain in order, by session, type or stamped reference.',
    query: {
      about: 'Entries about this page address (its topic, or naming the address).',
      since: 'Written after this day or ISO instant.',
      session: 'A session id.',
      type: 'An entry type.',
      ref: 'An external reference stamped by a short key.',
      cursor: 'The "next" of the previous page.',
      limit: 'At most this many (1–200).',
    },
    reply: ENTRY_LIST,
  },
  'POST /v1/brains/{slug}/corrections': {
    summary:
      'A person’s correction, written in the web (contributor or more), about a page or an entry; keys are refused.',
    status: 201,
    body: obj(
      {
        title: s('A short title.'),
        content: s('The correction.', { maxLength: 32000 }),
        appliesTo: s('The agent, account or label it applies to.'),
        page: s('The address of the page it is about.'),
        entry: s('The id of the entry it is about.'),
        requestKey: s('Repeating the request with the same key returns the same receipt.'),
      },
      ['appliesTo', 'page', 'entry', 'requestKey'],
    ),
    reply: obj({ receipt: RECEIPT }),
  },
  'PATCH /v1/entries/{id}': {
    summary: 'Change an entry (its author or a curator), against the revision you read.',
    body: obj(
      {
        baseRevision: n('The revision you read; another one gives entry_changed with "current".'),
        type: s('Type (never into or out of correction).'),
        title: s('Title.'),
        content: s('Content.'),
        appliesTo: nul(s('Who it applies to.')),
        tags: list(s('A tag.')),
        refs: list(s('A reference.')),
      },
      ['type', 'title', 'content', 'appliesTo', 'tags', 'refs'],
    ),
    reply: obj({ entry: ENTRY }),
  },
  'POST /v1/entries/{id}/forget': {
    summary: 'Forget an entry (its author or a curator), saying why; curators can recover it.',
    body: obj({ reason: s('Why, 1 to 500 characters.') }),
    reply: obj({ entry: ENTRY }),
  },
  'POST /v1/entries/{id}/recover': {
    summary: 'Recover a forgotten entry (curators).',
    reply: obj({ entry: ENTRY }),
  },
  'POST /v1/entries/{id}/pin': {
    summary: 'Pin an entry: always in the start context (curators).',
    reply: obj({ entry: ENTRY }),
  },
  'POST /v1/entries/{id}/unpin': {
    summary: 'Unpin an entry (curators).',
    reply: obj({ entry: ENTRY }),
  },
  'POST /v1/entries/{id}/schedule': {
    summary: 'Set or clear the review-after and expiry dates (its author or a curator).',
    body: obj(
      {
        reviewAfter: nul(s('A day or instant; null clears it.')),
        expiresAt: nul(s('A day or instant; null clears it.')),
      },
      ['reviewAfter', 'expiresAt'],
    ),
    reply: obj({ entry: ENTRY }),
  },
  'POST /v1/brains/{slug}/relations': {
    summary:
      'Relate two entries: contradicts, supersedes or not_related. From a key, touching a person’s correction waits for a person. In the web, superseding or dismissing a correction, or superseding someone else’s entry, is for that entry’s author or a curator.',
    status: 201,
    body: obj(
      {
        from: s('An entry id.'),
        to: s('Another entry id.'),
        kind: s('contradicts, supersedes or not_related.'),
        reason: s('Why.'),
      },
      ['reason'],
    ),
    reply: obj({ relation: RELATION }),
  },
  'GET /v1/brains/{slug}/conflicts': {
    summary: 'Open contradictions, and what waits for a person; by pages with limit and offset.',
    query: { limit: 'At most this many (1–200); all without it.', offset: 'The "next" of the page before.' },
    reply: obj({
      conflicts: list(
        obj({
          relation: RELATION,
          from: CONFLICT_SIDE,
          to: CONFLICT_SIDE,
          why: s('contradicts, or waiting for a person.'),
        }),
      ),
      total: n('How many are open.'),
      next: nul(s('The offset of the next page; null on the last.')),
    }),
  },
  'GET /v1/brains/{slug}/forgotten': {
    summary: 'Forgotten entries, with who forgot them and why (curators).',
    query: { cursor: 'The "next" of the previous page.', limit: 'At most this many (1–200).' },
    reply: ENTRY_LIST_READ,
  },
  'GET /v1/brains/{slug}/to-review': {
    summary: 'Entries past their review-after date.',
    query: { cursor: 'The "next" of the previous page.', limit: 'At most this many (1–200).' },
    reply: ENTRY_LIST_READ,
  },
  'GET /v1/brains/{slug}/uncompiled': {
    summary: 'Entries no wiki proposal has gathered yet.',
    query: { cursor: 'The "next" of the previous page.', limit: 'At most this many (1–200).' },
    reply: ENTRY_LIST_READ,
  },
  'GET /v1/search': {
    summary: 'Search entries and pages of the brains this key can read.',
    query: {
      q: 'What to look for.',
      brains: 'Comma-separated brains.',
      in: 'entries, pages or both.',
      types: 'Comma-separated entry types.',
      tags: 'Comma-separated tags.',
      prefix: 'Only under this topic or address.',
      from: 'From this day.',
      to: 'Up to this day.',
      neighbours: 'true for the pages linked to the results.',
      limit: 'At most this many (1–50).',
      offset: 'Skip this many (the "next" of the previous page).',
    },
    reply: obj({ items: list(HIT), next: nul(n('The offset of the next page.')), note: s('A hint.') }, [
      'note',
    ]),
  },
  'GET /v1/brains/{slug}/context': {
    summary: 'The start context of a brain, for a task and size.',
    query: { task: 'What you are about to do.', max: 'Characters (4000–128000).' },
    reply: obj({
      text: s('The context.'),
      chars: n('Its length.'),
      included: { type: 'object' },
      omitted: { type: 'object' },
      max: n('The size it was built for.'),
    }),
  },
  'GET /v1/brains/{slug}/proposals': {
    summary: 'Proposals of a brain (mine=1 for yours); the first page counts each status.',
    query: {
      status: 'A status (pending by default), or all.',
      mine: '1 for yours only.',
      cursor: 'The next page.',
      limit: 'How many (1–200).',
      order: 'newest (the default) or oldest first.',
    },
    reply: INBOX,
  },
  'GET /v1/proposals/{id}/review': {
    summary:
      'A proposal as a person reviews it in the web: each operation with the page before and after, what it depends on, and an old base in three versions. Any member reads it; only a curator decides.',
    reply: REVIEW,
  },
  'POST /v1/proposals/{id}/approve': {
    summary:
      'Approve a proposal in the web (curators): all of it, or the operations in "approve" with a "comment" for the rest. "corrections" replaces an operation first; "baseReviewed" accepts an old base.',
    body: obj(
      {
        fingerprint: s('The fingerprint of the review you saw.'),
        approve: list(n('Operation number.'), 'Approve only these; the rest goes back.'),
        comment: s('Why the rest goes back (needed when approving part).'),
        corrections: {
          type: 'object',
          description:
            'Operation number → { the fields you edited (title, summary, body; at least one), "revision" of the page you saw (edits), "purges" of the review }; laid over the operation and checked like any. A correction written before a purge of the wiki is refused (409 proposal_changed).',
        },
        baseReviewed: list(n('Operation number.'), 'Old bases you reviewed.'),
      },
      ['approve', 'comment', 'corrections', 'baseReviewed'],
    ),
    reply: DECISION,
  },
  'POST /v1/proposals/{id}/return': {
    summary: 'Return a whole proposal in the web (curators), with a comment the agent learns from.',
    body: obj({ fingerprint: s('The fingerprint of the review you saw.'), comment: s('Why it goes back.') }),
    reply: DECISION,
  },
  'POST /v1/brains/{slug}/proposals': {
    summary: 'Send a wiki proposal for a person to approve.',
    status: 201,
    body: obj(
      {
        title: s('What it changes.'),
        reason: s('Why.'),
        ops: list({ type: 'object' }, 'The operations.'),
        collected: list(s('Entry id.')),
        supersedes: s('A pending proposal of yours it replaces.'),
      },
      ['reason', 'collected', 'supersedes'],
    ),
    reply: { type: 'object' },
  },
  'GET /v1/brains/{slug}/trail': {
    summary: 'What was searched and read, by ref, session or page.',
    query: { ref: 'External reference.', session: 'Session id.', page: 'Page address.', after: 'Line id.' },
    reply: PAGE,
  },
  'GET /v1/brains/{slug}/events': {
    summary:
      'Live events of a brain (Server-Sent Events). Last-Event-ID (or ?lastEventId=) replays up to 24 hours.',
    query: { lastEventId: 'Resume after this event (or the Last-Event-ID header).' },
    stream: true,
  },
  'GET /v1/admin/settings': {
    summary: 'The settings of the installation (administration).',
    reply: obj({
      name: s('Name.'),
      publicUrl: nul(s('Address.')),
      curatorsInvite: b('Curators may invite.'),
      rateLimit: n('Requests per minute of each key.'),
    }),
  },
  'PUT /v1/admin/settings': {
    summary: 'Change the settings of the installation (administration).',
    body: obj(
      {
        name: s('Name.'),
        curatorsInvite: b('Curators may invite.'),
        rateLimit: n('Requests per minute of each key (1–100000).'),
      },
      ['name', 'curatorsInvite', 'rateLimit'],
    ),
  },
}

const ERROR = obj({
  error: obj(
    {
      code: s('A stable code.'),
      message: s('What happened.'),
      howToProceed: s('What to do next.'),
      retryAfter: n('Seconds to wait (rate_limited).'),
      current: { description: 'The current version, after a conflict.' },
      problems: { description: 'Everything wrong with a request checked as a whole.' },
    },
    ['retryAfter', 'current', 'problems'],
  ),
})

const PUBLIC_OPS = new Set(['GET /v1/health'])

function operationId(method: string, path: string): string {
  const words = path
    .replace(/^\/v1\//, '')
    .split(/[/.-]/)
    .filter(Boolean)
    .map((w) => (w.startsWith('{') ? `By${w.slice(1, -1)}` : w))
  return [method.toLowerCase(), ...words.map((w) => w[0]?.toUpperCase() + w.slice(1))].join('')
}

export function openapi(routes: Route[], serverUrl: string | null): Schema {
  const ops: Array<{ method: string; path: string; public: boolean }> = [
    { method: 'GET', path: '/v1/health', public: true },
    ...routes
      .filter((r) => r.path.startsWith('/v1/'))
      .map((r) => ({
        method: r.method,
        path: r.path.replace(/[:*](\w+)/g, '{$1}'),
        public: Boolean(r.public),
      })),
  ]
  const paths: Record<string, Record<string, Schema>> = {}
  for (const o of ops) {
    const key = `${o.method} ${o.path}`
    const hand = HAND[key]
    const params = [...o.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
      ...(m[1] === 'address' ? { description: 'A page address; it may hold slashes.' } : {}),
    }))
    const query = Object.entries(hand?.query ?? {}).map(([name, description]) => ({
      name,
      in: 'query',
      required: false,
      description,
      schema: { type: 'string' },
    }))
    const ok = hand?.image
      ? {
          description: 'The image; its type comes from its first bytes (PNG, WebP or JPEG).',
          content: Object.fromEntries(
            ['image/png', 'image/webp', 'image/jpeg'].map((t) => [
              t,
              { schema: { type: 'string', format: 'binary' } },
            ]),
          ),
        }
      : hand?.stream
        ? {
            description: 'A stream of events: "id:", "event:" and "data:" lines; "data" is an Event.',
            content: { 'text/event-stream': { schema: { $ref: '#/components/schemas/Event' } } },
          }
        : {
            description: hand ? 'Success.' : 'Success (201 when something was created).',
            content: { 'application/json': { schema: hand?.reply ?? { type: 'object' } } },
          }
    const op: Schema = {
      operationId: operationId(o.method, o.path),
      summary: hand?.summary ?? `${o.method} ${o.path}`,
      ...(params.length || query.length ? { parameters: [...params, ...query] } : {}),
      ...(hand?.body
        ? { requestBody: { required: true, content: { 'application/json': { schema: hand.body } } } }
        : ['POST', 'PUT', 'PATCH'].includes(o.method)
          ? { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } }
          : {}),
      responses: {
        [String(hand?.status ?? 200)]: ok,
        default: {
          description: 'A refusal: what happened and how to proceed.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
      ...(o.public || PUBLIC_OPS.has(key) ? { security: [] } : {}),
    }
    paths[o.path] = { ...(paths[o.path] ?? {}), [o.method.toLowerCase()]: op }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'rsc-brain API',
      version: '1',
      description:
        'The same operations as the MCP tools, with the same keys and permissions. Every refusal says what happened and how to proceed. Each key may make a limited number of requests per minute (429 with Retry-After beyond it). No answer passes 256000 characters: lists go by pages, and an answer that would pass the limit is cut and says so.',
    },
    servers: serverUrl ? [{ url: serverUrl }] : [],
    security: [{ bearer: [] }],
    paths,
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'A key of this installation.' },
      },
      schemas: { Error: ERROR, Event: EVENT },
    },
  }
}
