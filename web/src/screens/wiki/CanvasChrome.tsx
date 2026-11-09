// The controls over the graph's canvas (plan canvas-ui B.2): the legend at the bottom right, saying what the
// picture holds and only that, and the canvas while it loads: its dotted ground and grey cards.
import { useMemo } from 'preact/hooks'
import type { FamilyCount } from '../../graph/families.ts'
import type { Model } from '../../graph/model.ts'
import { LINE, SHAPES, shape } from '../../graph/render.ts'
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

// What the picture holds, and only that: the shapes of the types drawn, the kinds of the lines drawn.
export function Legend({
  model,
  nodes,
  edges,
  inFocus,
}: {
  model: Model
  nodes: Uint8Array
  edges: Uint8Array
  inFocus: boolean
}) {
  const g = T.graph
  const drawn = useMemo(() => {
    const types = new Set<string>()
    let superseded = false
    for (let i = 0; i < model.pages; i++) {
      const it = model.items[i]
      if (!nodes[i] || it?.kind !== 'page') continue
      types.add(it.type)
      if (it.status === 'superseded') superseded = true
    }
    const kinds = new Set<string>()
    for (let e = 0; e < edges.length; e++)
      if (edges[e])
        kinds.add((model.kind[e] as number) < 0 ? 'group' : (model.kinds[model.kind[e] as number] ?? ''))
    return { types, kinds, superseded }
  }, [model, nodes, edges])
  const shapes = SHAPES.filter((t) => drawn.types.has(t))
  const lines = [...KINDS, 'group'].filter((k) => drawn.kinds.has(k))
  return (
    <details class="graph-legend">
      <summary>{g.legend}</summary>
      <div class="legend-cols">
        <div>
          <p class="section-title">{g.shapes}</p>
          <ul class="plain">
            {shapes.map((t) => (
              <li key={t}>
                <ShapeIcon type={t} />
                {T.wiki.types[t]}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p class="section-title">{g.lines}</p>
          <ul class="plain">
            {lines.length ? null : <li class="meta">{g.noLinks}</li>}
            {lines.map((k) => {
              const line = LINE[k] ?? (LINE.related as (typeof LINE)[string])
              return (
                <li key={k}>
                  <svg
                    width="40"
                    height="12"
                    aria-hidden="true"
                    class={`legend-line${k === 'contradicts' ? ' danger' : k === 'group' ? ' group' : ''}`}
                  >
                    <line
                      x1="2"
                      y1="6"
                      x2={line.arrow ? 30 : 38}
                      y2="6"
                      stroke-width={k === 'group' ? 3 : line.width}
                      stroke-dasharray={line.dash.join(' ') || undefined}
                      stroke-linecap="round"
                    />
                    {line.arrow ? <polygon points="38,6 31,2.5 31,9.5" /> : null}
                  </svg>
                  {g.linkKindNames[k]}
                </li>
              )
            })}
          </ul>
        </div>
        <div>
          <p class="section-title">{g.marks}</p>
          <ul class="plain">
            {drawn.superseded ? <li>{g.dimmed}</li> : null}
            {lines.length ? <li>{g.bigger}</li> : null}
            {inFocus ? <li>{g.ringOne}</li> : null}
            {inFocus ? <li>{g.ringTwo}</li> : null}
          </ul>
          {lines.some((k) => LINE[k]?.arrow) ? <p class="meta">{g.arrows}</p> : null}
        </div>
      </div>
    </details>
  )
}

// The families drawn (spec amendment 2026-11-09, CA12): each with its shape in its colour, its name and how
// many of its pages are drawn, the biggest first. Colour is never the only sign: the shape and the name say
// the same.
export function FamilyLegend({ counts }: { counts: FamilyCount[] }) {
  const g = T.graph
  if (!counts.length) return null
  return (
    <section class="graph-families" aria-labelledby="graph-families-title">
      <h2 id="graph-families-title" class="sr-only">
        {g.families}
      </h2>
      <ul class="plain">
        {counts.map((c) => (
          <li key={c.type} data-c={c.colour}>
            <ShapeIcon type={c.type} />
            <span class="fam-name">{T.wiki.typesPlural[c.type] ?? c.type}</span>
            <span class="fam-count">{c.count.toLocaleString('en')}</span>
          </li>
        ))}
      </ul>
      <p class="fam-note">{g.familiesNote}</p>
    </section>
  )
}

// The shape of a page type as a small picture (the same path the canvas draws), as SVG.
function ShapeIcon({ type }: { type: string }) {
  const d = useMemo(() => {
    const parts: string[] = []
    const rec = {
      moveTo: (x: number, y: number) => parts.push(`M${x.toFixed(2)} ${y.toFixed(2)}`),
      lineTo: (x: number, y: number) => parts.push(`L${x.toFixed(2)} ${y.toFixed(2)}`),
      closePath: () => parts.push('Z'),
      rect: (x: number, y: number, w: number, h: number) => parts.push(`M${x} ${y}h${w}v${h}h${-w}Z`),
      arc: (cx: number, cy: number, r: number, _a: number, _b: number, ccw?: boolean) =>
        parts.push(
          `M${cx + r} ${cy}A${r} ${r} 0 1 ${ccw ? 0 : 1} ${cx - r} ${cy}A${r} ${r} 0 1 ${ccw ? 0 : 1} ${cx + r} ${cy}`,
        ),
    }
    shape(rec as unknown as Path2D, type, 8, 8, 5)
    return parts.join('')
  }, [type])
  return (
    <svg class="legend-shape" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d={d} fill-rule="evenodd" />
    </svg>
  )
}
