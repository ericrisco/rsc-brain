// A labelled input with its hint and its problem, wired for screen readers.
import type { JSX } from 'preact'
import { useId } from 'preact/hooks'

type Props = Omit<JSX.InputHTMLAttributes<HTMLInputElement>, 'id' | 'value' | 'onInput'> & {
  label: string
  hint?: string
  problem?: string | null
  value: string
  onValue: (v: string) => void
  after?: JSX.Element
}

export function Field({ label, hint, problem, value, onValue, after, ...input }: Props) {
  const id = useId()
  const described = [hint ? `${id}-hint` : '', problem ? `${id}-problem` : ''].filter(Boolean).join(' ')
  return (
    <div class="field">
      <label for={id}>{label}</label>
      {hint ? (
        <span id={`${id}-hint`} class="hint">
          {hint}
        </span>
      ) : null}
      <div class="input-row">
        <input
          type="text"
          {...input}
          id={id}
          value={value}
          onInput={(e) => onValue((e.currentTarget as HTMLInputElement).value)}
          aria-invalid={problem ? 'true' : undefined}
          aria-describedby={described || undefined}
        />
        {after}
      </div>
      {problem ? (
        <span id={`${id}-problem`} class="problem">
          {problem}
        </span>
      ) : null}
    </div>
  )
}
