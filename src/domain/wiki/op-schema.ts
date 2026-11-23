// The shape of a wiki operation as an agent reads it: a JSON Schema (one branch per kind of operation,
// told apart by "op") and one short example of each. The domain reads operations in model.ts (readOp);
// test/mcp/schema.test.ts proves the two agree, so a change to one without the other fails a test.
import {
  ADDRESS,
  LINK_KINDS,
  OP_KINDS,
  type OpKind,
  PAGE_STATUSES,
  PAGE_TYPES,
  WIKI_LIMITS,
} from './model.ts'

type Json = Record<string, unknown>

const address = (description: string) => ({
  type: 'string',
  maxLength: WIKI_LIMITS.address,
  pattern: ADDRESS.source,
  description,
})
const text = (max: number, description: string) => ({ type: 'string', maxLength: max, description })
const reason = text(WIKI_LIMITS.reason, 'Why. A curator reads it before approving.')
const tags = {
  type: 'array',
  items: { type: 'string', maxLength: WIKI_LIMITS.tag },
  maxItems: WIKI_LIMITS.tags,
  description: 'Short labels.',
}
const source = {
  oneOf: [
    {
      type: 'object',
      properties: { entryId: { type: 'string', description: 'A journal entry id (ent_…).' } },
      required: ['entryId'],
    },
    {
      type: 'object',
      properties: { url: { type: 'string' }, title: { type: 'string' } },
      required: ['url'],
    },
  ],
}
const sources = (description: string) => ({
  type: 'array',
  items: source,
  maxItems: WIKI_LIMITS.sources,
  description,
})
const linkRef = {
  type: 'object',
  properties: { kind: { type: 'string', enum: [...LINK_KINDS] }, to: address('The page it links to.') },
  required: ['kind', 'to'],
}
const links = (description: string) => ({
  type: 'array',
  items: linkRef,
  maxItems: WIKI_LIMITS.links,
  description,
})
const kind = (k: OpKind) => ({ type: 'string', const: k })
const branch = (op: OpKind, description: string, properties: Json, required: string[]) => ({
  type: 'object',
  description,
  properties: { op: kind(op), address: address('The page this applies to.'), ...properties, reason },
  required: ['op', 'address', ...required, 'reason'],
})

// One branch per operation, in the order of OP_KINDS.
export const OP_SCHEMAS: Json[] = [
  branch(
    'create',
    'A new page. An agent cites at least one source.',
    {
      type: { type: 'string', enum: [...PAGE_TYPES] },
      title: text(WIKI_LIMITS.title, 'The page title.'),
      summary: text(WIKI_LIMITS.summary, 'One or two lines.'),
      body: text(WIKI_LIMITS.body, 'Markdown; mention other pages with [[address]].'),
      tags,
      sources: sources('The journal entries (or urls) it comes from.'),
      links: links('Typed links to other pages.'),
    },
    ['type', 'title', 'sources'],
  ),
  branch(
    'edit',
    'Change a page. Send only the fields that change, at least one of type, title, summary, body, tags, sources.',
    {
      baseRevision: {
        type: 'integer',
        minimum: 1,
        description: 'The revision of the page you read; the edit is refused if the page moved on.',
      },
      type: { type: 'string', enum: [...PAGE_TYPES] },
      title: text(WIKI_LIMITS.title, 'The new title.'),
      summary: text(WIKI_LIMITS.summary, 'The new summary.'),
      body: text(WIKI_LIMITS.body, 'The whole new body.'),
      tags,
      sources: sources('The new list of sources.'),
    },
    [],
  ),
  branch('move', 'Give a page a new address.', { to: address('The new address.') }, ['to']),
  branch(
    'link',
    'Add a typed link from this page.',
    { kind: { type: 'string', enum: [...LINK_KINDS] }, to: address('The page it links to.') },
    ['kind', 'to'],
  ),
  branch(
    'unlink',
    'Remove a typed link from this page.',
    { kind: { type: 'string', enum: [...LINK_KINDS] }, to: address('The page it linked to.') },
    ['kind', 'to'],
  ),
  branch(
    'status',
    'Change the status of a page; "superseded" also names the page that replaces it.',
    {
      status: { type: 'string', enum: [...PAGE_STATUSES] },
      supersededBy: address('Only with status "superseded": the page that replaces this one.'),
    },
    ['status'],
  ),
  branch(
    'merge',
    'Fold another page into this one: the other page is retired and this one gets the new body.',
    {
      from: address('The page folded in.'),
      body: text(WIKI_LIMITS.body, 'The whole merged body.'),
      dropSources: sources('Sources of the merged page to leave out.'),
      dropLinks: links('Links of the merged page to leave out.'),
    },
    ['from', 'body'],
  ),
  branch(
    'revert',
    'Restore a page to one of its past revisions.',
    { toRevision: { type: 'integer', minimum: 1, description: 'The revision to restore.' } },
    ['toRevision'],
  ),
]

// What an agent sends for "ops": a non-empty list of operations, each one of the branches above.
export const OPS_SCHEMA = {
  type: 'array',
  minItems: 1,
  maxItems: WIKI_LIMITS.ops,
  items: { oneOf: OP_SCHEMAS },
  description:
    'The operations. Each has an "op" (create, edit, move, link, unlink, status, merge or revert), the "address" of its page and a "reason". An example of each is in the "operations" of brain_compile_pack.',
}

export const OP_EXAMPLES: Record<OpKind, Json> = {
  create: {
    op: 'create',
    address: 'audience/retention',
    type: 'topic',
    title: 'Audience retention',
    summary: 'What keeps viewers watching.',
    body: 'Hooks in the first ten seconds matter. See [[audience/hooks]].',
    tags: ['audience'],
    sources: [{ entryId: 'ent_0123456789ab' }],
    links: [{ kind: 'related', to: 'audience/hooks' }],
    reason: 'Three entries agree on this and no page covers it.',
  },
  edit: {
    op: 'edit',
    address: 'audience/retention',
    baseRevision: 3,
    body: 'The whole new body, with the correction folded in.',
    reason: 'A person corrected the intro length.',
  },
  move: {
    op: 'move',
    address: 'audience/hooks',
    to: 'audience/retention/hooks',
    reason: 'It is part of retention.',
  },
  link: {
    op: 'link',
    address: 'audience/retention',
    kind: 'depends-on',
    to: 'audience/hooks',
    reason: 'Retention advice relies on hooks.',
  },
  unlink: {
    op: 'unlink',
    address: 'audience/retention',
    kind: 'related',
    to: 'audience/old-ideas',
    reason: 'The link no longer holds.',
  },
  status: {
    op: 'status',
    address: 'audience/old-ideas',
    status: 'superseded',
    supersededBy: 'audience/retention',
    reason: 'Replaced by the retention page.',
  },
  merge: {
    op: 'merge',
    address: 'audience/retention',
    from: 'audience/watch-time',
    body: 'The merged body of both pages.',
    reason: 'The two pages said the same.',
  },
  revert: {
    op: 'revert',
    address: 'audience/retention',
    toRevision: 2,
    reason: 'Revision 3 lost a section.',
  },
}

// The same examples as text, in the order of OP_KINDS, for the guide an agent reads.
export const OP_GUIDE = `Operations (each needs "reason"; an edit names the "baseRevision" it read):\n${OP_KINDS.map(
  (k) => `- ${k}: ${JSON.stringify(OP_EXAMPLES[k])}`,
).join('\n')}`
