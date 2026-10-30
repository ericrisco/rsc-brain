// An invitation or reset link that is missing, used, expired or wrong: a page of its own, with a title
// and a way forward, never a dead end.
import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { T } from '../text.ts'

export function LinkProblem({
  title,
  message,
  how,
  children,
}: {
  title: string
  message: string
  how?: string | undefined
  children: ComponentChildren
}) {
  // It replaces a form the person was in: the keyboard goes to its title, unless it is elsewhere already.
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const a = document.activeElement
    if (!a || a === document.body) heading.current?.focus()
  }, [])
  return (
    <div class="state forbidden link-problem" role="alert" data-state="forbidden">
      <span class="kind">{T.kind.noLink}</span>
      <h1 class="title" tabIndex={-1} ref={heading}>
        {title}
      </h1>
      <p>{message}</p>
      {how ? <p class="how">{how}</p> : null}
      <div class="actions">{children}</div>
    </div>
  )
}
