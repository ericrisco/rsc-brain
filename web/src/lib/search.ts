// Search from anywhere (spec B6 «Search», T039): the request for the current brain or all of them, with the
// filters; and what to suggest when nothing is found.

export type SearchForm = {
  q: string
  // brain: the brain on screen; all: every brain the person is in.
  scope: 'brain' | 'all'
  brain: string | null
  what: '' | 'pages' | 'entries'
  type: string
  from: string
}

export const PAGE_SIZE = 20

export function searchParams(f: SearchForm, offset = 0): Record<string, string | number> {
  const out: Record<string, string | number> = { q: f.q.trim(), limit: PAGE_SIZE }
  if (f.scope === 'brain' && f.brain) out.brains = f.brain
  if (f.what) out.in = f.what
  if (f.type) out.types = f.type
  if (f.from) out.from = f.from
  if (offset) out.offset = offset
  return out
}

export const activeFilters = (f: Pick<SearchForm, 'what' | 'type' | 'from'>) =>
  [f.what, f.type, f.from].filter(Boolean).length

// What to offer when nothing is found: removing the filters, searching every brain, both or neither.
export function noResults(o: {
  filtered: boolean
  scope: 'brain' | 'all'
  inBrain: boolean
}): Array<'clear' | 'all'> {
  const out: Array<'clear' | 'all'> = []
  if (o.filtered) out.push('clear')
  if (o.scope === 'brain' && o.inBrain) out.push('all')
  return out
}

// The types a result may have: those of journal entries and of wiki pages (B1, B2).
export const ENTRY_TYPES = [
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
export const PAGE_TYPES = ['topic', 'entity', 'decision', 'guide', 'agent', 'source', 'overview']
export const TYPES = [...new Set([...ENTRY_TYPES, ...PAGE_TYPES])].sort()
