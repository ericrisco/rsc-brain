// A panel's head in the dark terminal style (shared.css v2, plan canvas-ui S.0): the numbered chip, the title
// (shown in capitals; its accessible name stays as written), what it is about after a "·", and the panel's
// own figure or word at the right, in its colour. The panel itself is the element with class "panel" and a
// family in data-c.
import type { ComponentChildren } from 'preact'

// The seven families in the order panels take them on a screen: neighbours never share a colour.
export const PANEL_COLOURS = ['orange', 'cyan', 'violet', 'green', 'pink', 'amber', 'blue'] as const
export type PanelColour = (typeof PANEL_COLOURS)[number]
export const colourAt = (k: number): PanelColour => PANEL_COLOURS[k % PANEL_COLOURS.length] as PanelColour

// "01", "02", …
export const panelNumber = (n: number) => String(n).padStart(2, '0')

export function PanelHead({
  n,
  id,
  title,
  about,
  meta,
  level = 2,
}: {
  n: number
  id?: string
  title: ComponentChildren
  // What the panel is about, after the title and a "·", in plain case.
  about?: ComponentChildren
  meta?: ComponentChildren
  level?: 2 | 3
}) {
  const H = level === 3 ? 'h3' : 'h2'
  return (
    <div class="panel-head">
      <span class="panel-num" aria-hidden="true">
        {panelNumber(n)}
      </span>
      <H id={id} class="panel-title">
        {title}
      </H>
      {about ? (
        <span class="panel-about">
          <span aria-hidden="true">· </span>
          {about}
        </span>
      ) : null}
      {meta !== undefined && meta !== null && meta !== '' ? <span class="panel-meta">{meta}</span> : null}
    </div>
  )
}
