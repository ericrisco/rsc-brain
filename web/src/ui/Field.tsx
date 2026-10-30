// A labelled input with its hint, its problem (what to fix: the field is invalid) or a note (a warning
// that does not stop the form), wired for screen readers.
import type { JSX } from 'preact'
import { useId } from 'preact/hooks'

type Props = Omit<JSX.InputHTMLAttributes<HTMLInputElement>, 'id' | 'value' | 'onInput'> & {
  label: string
  hint?: string
  problem?: string | null | undefined
  note?: string | null | undefined
  value: string
  onValue: (v: string) => void
  after?: JSX.Element
}

export function Field({ label, hint, problem, note, value, onValue, after, ...input }: Props) {
  const id = useId()
  const said = problem || note
  const described = [hint ? `${id}-hint` : '', said ? `${id}-problem` : ''].filter(Boolean).join(' ')
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
      {said ? (
        <span id={`${id}-problem`} class={problem ? 'problem' : 'note'}>
          {said}
        </span>
      ) : null}
    </div>
  )
}
