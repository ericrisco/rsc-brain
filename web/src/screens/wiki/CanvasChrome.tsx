// The controls over the graph's canvas (plan canvas-ui B.2): the legend at the bottom right, saying what the
// picture holds and only that, and the canvas while it loads: its dotted ground and grey cards.
import { useMemo, useState } from 'preact/hooks'
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

// The one legend over the canvas, at the top left (polish 2026-11-09): what the picture holds and only that.
// The families drawn (shape, colour, name and count), the kinds of the lines drawn and the marks. A panel that
// folds from its own header; open on a wide screen, folded on a narrow one.
export function Legend({
  model,
  nodes,
  edges,
  inFocus,
  counts,
}: {
  model: Model
  nodes: Uint8Array
  edges: Uint8Array
  inFocus: boolean
  counts: FamilyCount[]
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
  const [openAtStart] = useState(
    () => typeof matchMedia !== 'function' || !matchMedia('(max-width: 1099px)').matches,
  )
  return (
    <details class="graph-legend" open={openAtStart}>
      <summary class="legend-head">
        <span class="panel-num" aria-hidden="true">
          02
        </span>
        <span class="panel-title">{g.legend}</span>
        <span class="panel-meta">{g.familiesCount(counts.length)}</span>
      </summary>
      {counts.length ? (
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
        </section>
      ) : null}
      <details class="legend-more">
        <summary>{g.linesAndMarks}</summary>
        <div class="legend-cols">
          {counts.length ? null : (
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
          )}
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
      <p class="fam-note">{g.familiesNote}</p>
    </details>
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
