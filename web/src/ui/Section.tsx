// The head of a section: its title in sentence case at the section size, what it is about after it in grey, and
// its own figure or word at the right, in grey. No number, no colour.
import type { ComponentChildren } from 'preact'

export function SectionHead({
  id,
  title,
  about,
  meta,
  level = 2,
}: {
  id?: string
  title: ComponentChildren
  about?: ComponentChildren
  meta?: ComponentChildren
  level?: 2 | 3
}) {
  const H = level === 3 ? 'h3' : 'h2'
  return (
    <div class="sec-head">
      <H id={id} class="sec-title">
        {title}
      </H>
      {about ? <span class="sec-about">{about}</span> : null}
      {meta !== undefined && meta !== null && meta !== '' ? <span class="sec-meta">{meta}</span> : null}
    </div>
  )
}
