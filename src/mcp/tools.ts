// The tools an agent sees (spec B5 «Las herramientas»). Each one is a call to the same /v1 route a
// program would make, with the same key: same checks, same limits, same result. A tool only builds the
// request; the route does the rest. Write tools are not listed for a read-only key, and creating a
// brain only for a key that may.
import { type Principal, roleIn } from '../auth/principal.ts'
import { invalid } from '../core/errors.ts'
import type { Db } from '../db/db.ts'

type Json = Record<string, unknown>
export type Call = {
  method: 'GET' | 'POST' | 'PATCH'
  path: string
  query?: Record<string, string>
  body?: Json
}

export type Tool = {
  name: string
  title: string
  description: string
  inputSchema: Json
  writes: boolean // needs a read + write key
  creates?: boolean // needs the right to create brains
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean }
  call: (a: Json, k: Kit) => Promise<Call>
}

export type Kit = { db: Db; who: Principal; brain: (a: Json) => Promise<string> }

const str = (description: string, extra: Json = {}) => ({ type: 'string', description, ...extra })
const BRAIN = str(
  'The brain (its name). Optional when the key has one default brain or a session is given.',
  {
    maxLength: 64,
  },
)
const SESSION = str('A session id from mem_session_start; its brain becomes the default.', { maxLength: 40 })
const obj = (properties: Json, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
})
const enc = (s: string) => encodeURIComponent(s)

function text(a: Json, k: string, required = false): string | undefined {
  const v = a[k]
  if (v === undefined || v === null) {
    if (required) throw invalid(`"${k}" is required.`, `Add "${k}" to the call.`)
    return undefined
  }
  if (typeof v !== 'string') throw invalid(`"${k}" must be text.`, `Send "${k}" as a string.`)
  if (required && !v.trim()) throw invalid(`"${k}" is empty.`, `Give "${k}" a value.`)
  return v
}
const pick = (a: Json, keys: string[]) => {
  const out: Json = {}
  for (const k of keys) if (a[k] !== undefined) out[k] = a[k]
  return out
}
// A query value is text, a number or a yes/no; a list of those is joined with commas.
function scalar(k: string, v: unknown): string {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v)
  throw invalid(`"${k}" must be text, a number or true/false.`, `Send "${k}" as a plain value.`)
}
const query = (a: Json, keys: Record<string, string>) => {
  const out: Record<string, string> = {}
  for (const [arg, param] of Object.entries(keys)) {
    const v = a[arg]
    if (v === undefined || v === null) continue
    out[param] = Array.isArray(v) ? v.map((x) => scalar(arg, x)).join(',') : scalar(arg, v)
  }
  return out
}

const ENTRY_FIELDS = {
  type: str('decision, learning, discovery, attempt, preference, note or summary. Never "correction".'),
  title: str('A short title.'),
  content: str('The entry. Wrap private parts in <private>...</private>; never secrets.'),
  topic: str(
    'A stable topic key for what evolves (see mem_suggest_topic); saving the same topic revises it.',
  ),
  appliesTo: str('Who or what it applies to.'),
  tags: { type: 'array', items: { type: 'string' }, maxItems: 20 },
  refs: {
    type: 'array',
    items: { type: 'string' },
    maxItems: 20,
    description: 'Files, links, ids it refers to.',
  },
  reviewAfter: str('A day to review it (YYYY-MM-DD).'),
  expiresAt: str('A day after which it no longer holds (YYYY-MM-DD).'),
  requestKey: str('Any unique text: repeating the call with the same key returns the same receipt.'),
}

export const TOOLS: Tool[] = [
  {
    name: 'brain_list',
    title: 'List my brains',
    description: 'The brains this key can use: name, purpose and your role in each.',
    inputSchema: obj({}),
    writes: false,
    annotations: { readOnlyHint: true },
    call: async () => ({ method: 'GET', path: '/v1/brains' }),
  },
  {
    name: 'brain_resolve',
    title: 'Which brain is this repository',
    description:
      'Given the remote of the repository you work in (git remote get-url origin), says which brain is its. Call it first.',
    inputSchema: obj({ repos: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 } }, [
      'repos',
    ]),
    writes: false,
    annotations: { readOnlyHint: true },
    call: async (a) => ({ method: 'POST', path: '/v1/resolve', body: pick(a, ['repos']) }),
  },
  {
    name: 'mem_context',
    title: 'Start context',
    description:
      'What to know before working in a brain: purpose, corrections, pinned, the map, recent work. Optionally for a task.',
    inputSchema: obj({
      brain: BRAIN,
      session: SESSION,
      task: str('What you are about to do.'),
      max: { type: 'integer', minimum: 1000, maximum: 60000 },
    }),
    writes: false,
    annotations: { readOnlyHint: true },
    call: async (a, k) => ({
      method: 'GET',
      path: `/v1/brains/${enc(await k.brain(a))}/context`,
      query: query(a, { task: 'task', max: 'max' }),
    }),
  },
  {
    name: 'mem_session_start',
    title: 'Start a session',
    description: 'Opens a working session with its purpose. Pass the returned session id to later calls.',
    inputSchema: obj({
      brain: BRAIN,
      purpose: str('What this session is for.'),
      ref: str('An external reference, such as a ticket.'),
    }),
    writes: true,
    annotations: { readOnlyHint: false },
    call: async (a, k) => ({
      method: 'POST',
      path: `/v1/brains/${enc(await k.brain(a))}/sessions`,
      body: pick(a, ['purpose', 'ref']),
    }),
  },
  {
    name: 'mem_save',
    title: 'Save an entry',
    description:
      'Writes to the journal: a decision with its why, a discovery, a failed attempt, a correction from the person (as "learning"). Returns a receipt with similar entries.',
    inputSchema: obj({ brain: BRAIN, session: SESSION, ...ENTRY_FIELDS }, ['type', 'title', 'content']),
    writes: true,
    annotations: { readOnlyHint: false, idempotentHint: true },
    call: async (a, k) => ({
      method: 'POST',
      path: `/v1/brains/${enc(await k.brain(a))}/entries`,
      body: { ...pick(a, Object.keys(ENTRY_FIELDS)), ...(a.session ? { sessionId: a.session } : {}) },
    }),
  },
  {
    name: 'mem_update',
    title: 'Correct an entry',
    description:
      'Changes one of your entries, against the revision you read (to avoid overwriting someone else).',
    inputSchema: obj(
      {
        id: str('The entry id.'),
        baseRevision: { type: 'integer', minimum: 1 },
        type: ENTRY_FIELDS.type,
        title: ENTRY_FIELDS.title,
        content: ENTRY_FIELDS.content,
        appliesTo: ENTRY_FIELDS.appliesTo,
        tags: ENTRY_FIELDS.tags,
        refs: ENTRY_FIELDS.refs,
      },
      ['id', 'baseRevision'],
    ),
    writes: true,
    annotations: { readOnlyHint: false },
    call: async (a) => ({
      method: 'PATCH',
      path: `/v1/entries/${enc(text(a, 'id', true) as string)}`,
      body: pick(a, ['baseRevision', 'type', 'title', 'content', 'appliesTo', 'tags', 'refs']),
    }),
  },
  {
    name: 'mem_suggest_topic',
    title: 'Suggest a topic',
    description:
      'A topic key for a title, with the similar topics that already exist (reuse one if it fits).',
    inputSchema: obj({ brain: BRAIN, session: SESSION, title: str('The title of what you will save.') }, [
      'title',
    ]),
    writes: false,
    annotations: { readOnlyHint: true },
    call: async (a, k) => ({
      method: 'POST',
      path: `/v1/brains/${enc(await k.brain(a))}/topics/suggest`,
      body: pick(a, ['title']),
    }),
  },
  {
    name: 'mem_relate',
    title: 'Relate two entries',
    description: 'Records that one entry contradicts or supersedes another, or that they are not related.',
    inputSchema: obj(
      {
        brain: BRAIN,
        session: SESSION,
        from: str('Entry id.'),
        to: str('Entry id.'),
        kind: { type: 'string', enum: ['contradicts', 'supersedes', 'not_related'] },
        reason: str('Why.'),
      },
      ['from', 'to', 'kind'],
    ),
    writes: true,
    annotations: { readOnlyHint: false },
    call: async (a, k) => ({
      method: 'POST',
      path: `/v1/brains/${enc(await k.brain(a))}/relations`,
      body: pick(a, ['from', 'to', 'kind', 'reason']),
    }),
  },
  {
    name: 'mem_forget',
    title: 'Forget an entry',
    description: 'Forgets one of your entries, with a reason. It can be recovered in the web.',
    inputSchema: obj({ id: str('The entry id.'), reason: str('Why it should be forgotten.') }, [
      'id',
      'reason',
    ]),
    writes: true,
    annotations: { readOnlyHint: false, destructiveHint: true },
    call: async (a) => ({
      method: 'POST',
      path: `/v1/entries/${enc(text(a, 'id', true) as string)}/forget`,
      body: pick(a, ['reason']),
    }),
  },
  {
    name: 'mem_session_summary',
    title: 'Close a session with its summary',
    description:
      'Closes the session with what was the goal, what was done, discovered, decided and is pending.',
    inputSchema: obj(
      {
        session: str('The session id.'),
        title: str('Optional title.'),
        content: str('The summary.'),
        requestKey: ENTRY_FIELDS.requestKey,
      },
      ['session', 'content'],
    ),
    writes: true,
    annotations: { readOnlyHint: false, idempotentHint: true },
    call: async (a) => ({
      method: 'POST',
      path: `/v1/sessions/${enc(text(a, 'session', true) as string)}/summary`,
      body: pick(a, ['title', 'content', 'requestKey']),
    }),
  },
  {
    name: 'mem_session_end',
    title: 'Close a session without summary',
    description: 'Closes a session you opened, without a summary (it shows as "closed without summary").',
    inputSchema: obj({ session: str('The session id.') }, ['session']),
    writes: true,
    annotations: { readOnlyHint: false },
    call: async (a) => ({
      method: 'POST',
      path: `/v1/sessions/${enc(text(a, 'session', true) as string)}/end`,
    }),
  },
  {
    name: 'mem_search',
    title: 'Search',
    description:
      'Searches entries and wiki pages of the brains this key can read (or the ones named), by words and meaning. Search before you decide.',
    inputSchema: obj(
      {
        q: str('What to look for.'),
        brains: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 20,
          description: 'Limit to these brains.',
        },
        in: { type: 'string', enum: ['entries', 'pages', 'both'] },
        types: { type: 'array', items: { type: 'string' }, maxItems: 10 },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 10 },
        prefix: str('Only pages under this address.'),
        from: str('From this day (YYYY-MM-DD).'),
        to: str('Up to this day (YYYY-MM-DD).'),
        neighbours: { type: 'boolean', description: 'Also the pages linked to the results.' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        offset: { type: 'integer', minimum: 0 },
      },
      ['q'],
    ),
    writes: false,
    annotations: { readOnlyHint: true },
    call: async (a) => ({
      method: 'GET',
      path: '/v1/search',
      query: query(a, {
        q: 'q',
        brains: 'brains',
        in: 'in',
        types: 'types',
        tags: 'tags',
        prefix: 'prefix',
        from: 'from',
        to: 'to',
        neighbours: 'neighbours',
        limit: 'limit',
        offset: 'offset',
      }),
    }),
  },
  {
    name: 'mem_get',
    title: 'Read an entry',
    description: 'One entry in full, with its history if asked.',
    inputSchema: obj({ id: str('The entry id.'), history: { type: 'boolean' } }, ['id']),
    writes: false,
    annotations: { readOnlyHint: true },
    call: async (a) => ({
      method: 'GET',
      path: `/v1/entries/${enc(text(a, 'id', true) as string)}`,
      query: a.history === true ? { history: '1' } : {},
    }),
  },
  {
    name: 'mem_timeline',
    title: 'Around an entry, or recent sessions',
    description:
      'With an entry id: the entries written around it. Without: the recent sessions of the brain.',
    inputSchema: obj({
      id: str('An entry id.'),
      n: { type: 'integer', minimum: 1, maximum: 50 },
      brain: BRAIN,
      session: SESSION,
    }),
    writes: false,
    annotations: { readOnlyHint: true },
    call: async (a, k) =>
      a.id !== undefined
        ? {
            method: 'GET',
            path: `/v1/entries/${enc(text(a, 'id') as string)}/around`,
            query: query(a, { n: 'n' }),
          }
        : {
            method: 'GET',
            path: `/v1/brains/${enc(await k.brain(a))}/sessions`,
            query: query(a, { n: 'limit' }),
          },
  },
  {
    name: 'brain_page',
    title: 'Read a wiki page',
    description: 'A page by its address (such as audience/retention), with its links and sources.',
    inputSchema: obj({ brain: BRAIN, session: SESSION, address: str('The page address.') }, ['address']),
    writes: false,
    annotations: { readOnlyHint: true },
    call: async (a, k) => ({
      method: 'GET',
      path: `/v1/brains/${enc(await k.brain(a))}/pages/${(text(a, 'address', true) as string).split('/').map(enc).join('/')}`,
    }),
  },
  {
    name: 'brain_neighbors',
    title: 'Linked pages',
    description: 'The pages linked to a page, by kind of link, one or two hops away.',
    inputSchema: obj(
      {
        brain: BRAIN,
        session: SESSION,
        address: str('The page address.'),
        hops: { type: 'integer', minimum: 1, maximum: 2 },
        direction: { type: 'string', enum: ['out', 'in', 'both'] },
        kinds: { type: 'array', items: { type: 'string' }, maxItems: 10 },
      },
      ['address'],
    ),
    writes: false,
    annotations: { readOnlyHint: true },
    call: async (a, k) => ({
      method: 'GET',
      path: `/v1/brains/${enc(await k.brain(a))}/neighbours`,
      query: query(a, { address: 'address', hops: 'hops', direction: 'direction', kinds: 'kinds' }),
    }),
  },
  {
    name: 'brain_map',
    title: 'The map',
    description: 'The map of the brain’s wiki: its areas and main pages.',
    inputSchema: obj({ brain: BRAIN, session: SESSION }),
    writes: false,
    annotations: { readOnlyHint: true },
    call: async (a, k) => ({ method: 'GET', path: `/v1/brains/${enc(await k.brain(a))}/wiki/map` }),
  },
  {
    name: 'brain_health',
    title: 'Wiki health',
    description: 'What needs care in the wiki: stale, orphan, contradicted or too long pages.',
    inputSchema: obj({ brain: BRAIN, session: SESSION }),
    writes: false,
    annotations: { readOnlyHint: true },
    call: async (a, k) => ({ method: 'GET', path: `/v1/brains/${enc(await k.brain(a))}/wiki/health` }),
  },
  {
    name: 'brain_compile_pack',
    title: 'Pack to compile',
    description:
      'What to compile into the wiki: pending entries, corrections, the map, related pages and the guide.',
    inputSchema: obj({
      brain: BRAIN,
      session: SESSION,
      maxChars: { type: 'integer', minimum: 4000, maximum: 400000 },
    }),
    writes: false,
    annotations: { readOnlyHint: true },
    call: async (a, k) => ({
      method: 'GET',
      path: `/v1/brains/${enc(await k.brain(a))}/wiki/compile`,
      query: query(a, { maxChars: 'maxChars' }),
    }),
  },
  {
    name: 'brain_propose',
    title: 'Propose wiki changes',
    description:
      'Sends changes to the wiki for a person to approve: operations citing their source entries, entries collected unchanged, and which proposal it replaces. Returns its problems or its id.',
    inputSchema: obj(
      {
        brain: BRAIN,
        session: SESSION,
        title: str('What it changes, in one line.'),
        reason: str('Why.'),
        ops: {
          type: 'array',
          items: { type: 'object' },
          minItems: 1,
          description: 'The operations (see the guide in brain_compile_pack).',
        },
        collected: {
          type: 'array',
          items: { type: 'string' },
          description: 'Entry ids compiled with no change to the wiki.',
        },
        supersedes: str('The id of a pending proposal of yours that this one replaces.'),
      },
      ['title', 'ops'],
    ),
    writes: true,
    annotations: { readOnlyHint: false },
    call: async (a, k) => ({
      method: 'POST',
      path: `/v1/brains/${enc(await k.brain(a))}/proposals`,
      body: pick(a, ['title', 'reason', 'ops', 'collected', 'supersedes']),
    }),
  },
  {
    name: 'brain_proposals',
    title: 'My proposals',
    description:
      'Your proposals in a brain and what became of them: pending (and whether old), approved, returned with the comment, withdrawn or superseded.',
    inputSchema: obj({
      brain: BRAIN,
      session: SESSION,
      status: {
        type: 'string',
        enum: ['all', 'pending', 'approved', 'partially_approved', 'returned', 'withdrawn', 'superseded'],
      },
      cursor: str('The "next" value of the previous page.'),
    }),
    writes: false,
    annotations: { readOnlyHint: true },
    call: async (a, k) => ({
      method: 'GET',
      path: `/v1/brains/${enc(await k.brain(a))}/proposals`,
      query: { mine: '1', status: text(a, 'status') ?? 'all', ...query(a, { cursor: 'cursor' }) },
    }),
  },
  {
    name: 'brain_withdraw',
    title: 'Withdraw a proposal',
    description: 'Withdraws a pending proposal of yours.',
    inputSchema: obj({ id: str('The proposal id.') }, ['id']),
    writes: true,
    annotations: { readOnlyHint: false },
    call: async (a) => ({
      method: 'POST',
      path: `/v1/proposals/${enc(text(a, 'id', true) as string)}/withdraw`,
    }),
  },
  {
    name: 'brain_create',
    title: 'Create a brain',
    description: 'Creates a brain (when this key may). A service account names its first curator.',
    inputSchema: obj(
      {
        slug: str('Its name: lowercase letters, digits and hyphens.'),
        name: str('A display name.'),
        purpose: str('What it is for, in a sentence.'),
        description: str('More about it.'),
        firstCurator: str('For a service account: the email of the person who will curate it.'),
      },
      ['slug'],
    ),
    writes: true,
    creates: true,
    annotations: { readOnlyHint: false },
    call: async (a) => ({
      method: 'POST',
      path: '/v1/brains',
      body: pick(a, ['slug', 'name', 'purpose', 'description', 'firstCurator']),
    }),
  },
]

// What this key may call: write tools need read + write; creating needs the right to create brains.
export type Refusal = { code: string; message: string; howToProceed: string }

export function allowed(t: Tool, who: Principal): Refusal | null {
  if (t.writes && who.credential.perm === 'read') {
    return {
      code: 'read_only_key',
      message: `This key is read-only, so "${t.name}" is not available.`,
      howToProceed: 'Use a read + write token, or connect again choosing read and write.',
    }
  }
  if (t.creates && (!(who.isAdmin || who.canCreateBrains) || who.credential.kind === 'short')) {
    return {
      code: 'cannot_create_brains',
      message: 'This key cannot create brains.',
      howToProceed: 'Ask the administration for the "can create brains" permission, and use your own token.',
    }
  }
  return null
}

// The brains this key can use, by name (the same narrowing as brain_list).
async function visible(db: Db, who: Principal): Promise<string[]> {
  const rows = await db.query(
    `SELECT b.id, b.slug FROM memberships m JOIN brains b ON b.id = m.brain_id
      WHERE m.account_id = $1 ORDER BY b.slug`,
    [who.accountId],
  )
  const out: string[] = []
  for (const r of rows) if (await roleIn(db, who, String(r.id))) out.push(String(r.slug))
  return out
}

// The brain a call is about when it names none: the session's (one this key can use), the short key's
// write brain, or the only brain the key reaches.
export async function defaultBrain(db: Db, who: Principal, a: Json): Promise<string> {
  const named = text(a, 'brain')
  if (named) return named
  const session = text(a, 'session')
  if (session) {
    const s = await db.one<{ id: string; slug: string }>(
      'SELECT b.id, b.slug FROM sessions s JOIN brains b ON b.id = s.brain_id WHERE s.id = $1',
      [session],
    )
    // Someone else's session and one that does not exist answer the same.
    if (!s || !(await roleIn(db, who, s.id))) {
      throw invalid(
        'That session is not one this key can use.',
        'Pass the "session" that mem_session_start gave you, or name the "brain".',
      )
    }
    return s.slug
  }
  const c = who.credential
  if (c.kind === 'short' && c.writeBrainId) {
    const b = await db.one<{ slug: string }>('SELECT slug FROM brains WHERE id = $1', [c.writeBrainId])
    if (b) return b.slug
  }
  const mine = await visible(db, who)
  if (mine.length === 1) return mine[0] as string
  if (mine.length === 0) {
    throw invalid(
      'This key reaches no brain.',
      'Ask a curator to add you to a brain, or use a key that reaches one.',
    )
  }
  throw invalid(
    `Which brain? This key reaches ${mine.length}, and the call names none.`,
    `Pass "brain" (one of: ${mine.slice(0, 10).join(', ')}${mine.length > 10 ? ', …' : ''}), call brain_resolve for your repository, or pass the "session" from mem_session_start.`,
  )
}
