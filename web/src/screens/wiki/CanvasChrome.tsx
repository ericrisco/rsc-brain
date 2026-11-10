// The controls over the graph's canvas (plan canvas-ui B.2; v0.5.0): the Communities panel at the right,
// which names the clusters the picture is coloured by and hides them, and the canvas while it loads.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { type Communities, NO_LINKS, OTHER } from '../../graph/communities.ts'
import { T } from '../../text.ts'

// The canvas while the graph loads, in the shape it will have.
export function CanvasSkeleton({ wait = false }: { wait?: boolean }) {
  const cards = Array.from({ length: 7 }, (_, i) => <span key={i} class="skeleton-card" aria-hidden="true" />)
  if (wait) return <div class="graph-wait">{cards}</div>
  return (
    <div class="graph-box loading" role="status" aria-live="polite" data-state="loading">
      <span class="sr-only">{T.states.loading}</span>
      {cards}
    </div>
  )
}

export const KINDS = [
  'mentions',
  'related',
  'depends-on',
  'contradicts',
  'supersedes',
  'part-of',
  'example-of',
]

// The row of the panel an item is in: its community (a colour of its own), the small ones together, or the
// pages without links.
export const hiddenKey = (c: Communities, i: number) => {
  const of = c.of[i] as number
  if (of === NO_LINKS) return 'none'
  if (of < 0 || c.colour[i] === OTHER) return 'other'
  return `c:${of}`
}

type Row = { key: string; name: string; count: number; colour: string }

// The communities drawn, the biggest first (as the picture is coloured), each with a box that shows or hides
// it: a colour dot, its name and how many it holds. "Select all" shows or hides them all at once. A panel that
// folds from its own head; open on a wide screen, folded on a narrow one.
export function CommunitiesPanel({
  communities,
  nodes,
  hidden,
  onChange,
}: {
  communities: Communities
  // What the filters leave: the counts are of those.
  nodes: Uint8Array
  hidden: ReadonlySet<string>
  onChange: (hidden: ReadonlySet<string>) => void
}) {
  const g = T.graph
  const rows = useMemo(() => {
    const count = new Map<string, number>()
    for (let i = 0; i < nodes.length; i++) {
      if (!nodes[i]) continue
      const k = hiddenKey(communities, i)
      count.set(k, (count.get(k) ?? 0) + 1)
    }
    const out: Row[] = []
    for (const c of communities.list)
      if (c.colour !== OTHER && count.get(`c:${c.id}`))
        out.push({
          key: `c:${c.id}`,
          name: c.name,
          count: count.get(`c:${c.id}`) as number,
          colour: `${c.colour}`,
        })
    if (count.get('other'))
      out.push({
        key: 'other',
        name: g.otherCommunities,
        count: count.get('other') as number,
        colour: 'other',
      })
    if (count.get('none'))
      out.push({ key: 'none', name: g.noLinksRow, count: count.get('none') as number, colour: 'lone' })
    return out
  }, [communities, nodes])
  const shown = rows.filter((r) => !hidden.has(r.key)).length
  const all = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (all.current) all.current.indeterminate = shown > 0 && shown < rows.length
  }, [shown, rows.length])
  const [openAtStart] = useState(
    () => typeof matchMedia !== 'function' || !matchMedia('(max-width: 1099px)').matches,
  )
  const set = (key: string, on: boolean) => {
    const next = new Set(hidden)
    if (on) next.delete(key)
    else next.add(key)
    onChange(next)
  }
  return (
    <details class="graph-communities" open={openAtStart}>
      <summary class="com-head">
        <span class="panel-title">{g.communities}</span>
        <span class="panel-meta">{rows.length.toLocaleString('en')}</span>
      </summary>
      <fieldset class="com-list">
        <legend class="sr-only">{g.communitiesShown}</legend>
        <label class="com-row com-all">
          <input
            ref={all}
            type="checkbox"
            checked={shown === rows.length}
            onChange={(e) =>
              onChange(
                (e.currentTarget as HTMLInputElement).checked ? new Set() : new Set(rows.map((r) => r.key)),
              )
            }
          />
          <span class="com-name">{g.selectAll}</span>
        </label>
        <ul class="plain">
          {rows.map((r) => (
            <li key={r.key}>
              <label class="com-row" data-com={r.colour}>
                <input
                  type="checkbox"
                  checked={!hidden.has(r.key)}
                  onChange={(e) => set(r.key, (e.currentTarget as HTMLInputElement).checked)}
                />
                <span class="com-dot" aria-hidden="true" />
                <span class="com-name">{r.name}</span>
                <span class="com-count">{r.count.toLocaleString('en')}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
    </details>
  )
}
