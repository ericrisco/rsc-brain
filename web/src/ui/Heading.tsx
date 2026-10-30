// A page title that takes the keyboard when a step finishes (a reset saved, a link sent), so a screen
// reader announces the new state and Tab goes on from there.
import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'

export function StepTitle({ children }: { children: ComponentChildren }) {
  const ref = useRef<HTMLHeadingElement>(null)
  useEffect(() => ref.current?.focus(), [])
  return (
    <h1 class="title" tabIndex={-1} ref={ref}>
      {children}
    </h1>
  )
}
