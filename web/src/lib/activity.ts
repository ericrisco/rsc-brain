// Activity in words (spec B6 «Activity: en vivo», T037): who did what, with which client, and the filters by
// client, kind and reference. A Factory reference links to its run only when the installation has a Factory
// address that passes the same safe-address rule as the server (plan §3.5, CA9); otherwise it is text.
import type { LiveEvent } from '../live/stream.ts'
import { T } from '../text.ts'
import { clientLabel } from './brains.ts'

// The same rule as src/core/urls.ts (a test keeps them equal): http(s), a plain host, an optional port and
// path; no credentials, no query, no fragment.
export const SAFE_URL = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/

// The kinds a person filters by, in the order they matter: what changed first, what was looked at last.
export const KINDS = [
  { id: 'writes', test: (k: string) => k.startsWith('entry.') },
  { id: 'sessions', test: (k: string) => k.startsWith('session.') },
  { id: 'proposals', test: (k: string) => k.startsWith('proposal.') },
  { id: 'wiki', test: (k: string) => k.startsWith('wiki.') },
  { id: 'searches', test: (k: string) => k === 'search' },
  { id: 'reads', test: (k: string) => k === 'read' },
] as const

const kindOf = (k: string) => KINDS.find((x) => x.test(k))?.id ?? ''

export type Said = { who: string; client: string | null; did: string; what: string | null; kind: string }

export function describeEvent(e: LiveEvent): Said {
  const a = T.activity
  const label = e.target?.label ?? null
  let did = a.did[e.kind] ?? e.kind
  let what: string | null = label
  if (e.kind === 'search') what = e.query ? `“${e.query}”` : null
  else if (e.kind === 'proposal.decided') {
    did = label ? `${did}: ${label.replace(/_/g, ' ')}` : did
    what = null
  } else if (e.kind === 'session.closed' || e.kind === 'wiki.changed') what = label
  return {
    who: e.who?.name || a.installation,
    client: clientLabel(e.client),
    did,
    what,
    kind: kindOf(e.kind),
  }
}

export type ActivityFilters = { client: string; kind: string; ref: string }

export function filterEvents(events: readonly LiveEvent[], f: ActivityFilters): LiveEvent[] {
  const ref = f.ref.trim().toLowerCase()
  return events.filter(
    (e) =>
      (!f.client || clientLabel(e.client) === f.client) &&
      (!f.kind || kindOf(e.kind) === f.kind) &&
      (!ref || (e.key?.ref ?? '').toLowerCase().includes(ref)),
  )
}

// The clients seen, as a person says them, for the filter.
export function clientsOf(events: readonly LiveEvent[]): string[] {
  const seen = new Set<string>()
  for (const e of events) {
    const c = clientLabel(e.client)
    if (c) seen.add(c)
  }
  return [...seen].sort((x, y) => x.localeCompare(y))
}

// `<factoryUrl>/runs/<runId>` for a reference that names a Factory run (r_…), with a safe Factory address;
// null otherwise (the reference is shown as text).
export function factoryRunHref(
  factoryUrl: string | null | undefined,
  ref: string | null | undefined,
): string | null {
  if (!factoryUrl || !ref || !SAFE_URL.test(factoryUrl)) return null
  const run = /(?:^|[^A-Za-z0-9_])(r_[A-Za-z0-9_-]+)/.exec(ref)?.[1]
  if (!run) return null
  return `${factoryUrl.replace(/\/+$/, '')}/runs/${run}`
}
