// The common states of every screen (spec B6 «Estados en todas las pantallas»): a skeleton with the shape
// of the content, empty with the first action, filtered-empty with the way back, an error that says what
// happened and offers to try again, offline, and no access that says who to ask. Never a blank page.
import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import type { ApiError } from '../api/client.ts'
import { focusOnArrival } from '../lib/screen.ts'
import { online } from '../session.ts'
import { T } from '../text.ts'
import { Button } from './Button.tsx'
import { errorView } from './state.ts'

export function Skeleton({ rows = 3, label = T.states.loading }: { rows?: number; label?: string }) {
  return (
    <div class="skeleton" role="status" aria-live="polite" data-state="loading">
      <span class="sr-only">{label}</span>
      <div class="bar narrow" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} class="block" />
      ))}
    </div>
  )
}

// The kind of a state, as a word in sentence case.
const KIND = { error: T.kind.error, offline: T.kind.offline, forbidden: T.kind.noAccess } as const

// `focus`: off for a part of a screen that failed while the rest stands (the keyboard stays where it is;
// the alert is still announced).
export function ErrorState({
  error,
  onRetry,
  focus = true,
}: {
  error: ApiError
  onRetry?: () => void
  focus?: boolean
}) {
  const v = errorView(error, online.value)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focus) focusOnArrival(ref.current)
  }, [])
  return (
    <div class={`state ${v.kind}`} role="alert" tabIndex={-1} ref={ref} data-state={v.kind}>
      <span class="kind">{KIND[v.kind]}</span>
      <h2>{v.title}</h2>
      <p>{v.message}</p>
      <p class="how">{v.howToProceed}</p>
      {v.retry && onRetry ? (
        <Button kind="secondary" onClick={onRetry}>
          {T.states.tryAgain}
        </Button>
      ) : null}
      {/* No access: one way out on every screen, besides whom to ask. */}
      {v.kind === 'forbidden' ? (
        <p>
          <a href="/">{T.states.goHome}</a>
        </p>
      ) : null}
    </div>
  )
}

export function Empty({
  title,
  children,
  filtered,
  onClear,
}: {
  title: string
  children?: ComponentChildren
  filtered?: boolean
  onClear?: () => void
}) {
  return (
    <div class="state" data-state={filtered ? 'filtered-empty' : 'empty'}>
      <h2>{filtered ? T.states.filteredEmpty : title}</h2>
      {children}
      {filtered && onClear ? <Button onClick={onClear}>{T.states.clearFilters}</Button> : null}
    </div>
  )
}

export function OfflineStrip() {
  if (online.value) return null
  return (
    <div class="offline-strip" role="status" data-state="offline">
      <strong>{T.kind.offline}</strong>
      <span>{T.shell.offline}</span>
    </div>
  )
}

// A refusal shown inside a form: what happened and what to do. Focused when it appears, so a screen
// reader hears it and the keyboard is next to it.
export function FormAlert({
  error,
  tone = 'error',
  focus = true,
}: {
  error: { message: string; howToProceed?: string } | null
  tone?: 'error' | 'warn' | 'ok'
  // Off when the form puts the keyboard on the field to fix instead; the alert is still announced.
  focus?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (error && focus) ref.current?.focus()
  }, [error])
  if (!error) return null
  return (
    <div
      class={`alert ${tone === 'error' ? '' : tone}`}
      role={tone === 'ok' ? 'status' : 'alert'}
      tabIndex={-1}
      ref={ref}
    >
      <span class="kind">
        {tone === 'error' ? T.kind.problem : tone === 'warn' ? T.kind.warning : T.kind.done}
      </span>
      <span>{error.message}</span>
      {error.howToProceed ? <span class="muted">{error.howToProceed}</span> : null}
    </div>
  )
}
