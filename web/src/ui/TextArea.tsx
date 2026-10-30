// A labelled multi-line field, wired like Field (hint, problem, screen readers).
import type { JSX } from 'preact'
import { useId } from 'preact/hooks'

type Props = Omit<JSX.TextareaHTMLAttributes<HTMLTextAreaElement>, 'id' | 'value' | 'onInput'> & {
  // A known id, when a form puts the keyboard on this field by name.
  id?: string
  label: string
  hint?: string
  problem?: string | null | undefined
  value: string
  onValue: (v: string) => void
}

export function TextArea({ id: given, label, hint, problem, value, onValue, ...input }: Props) {
  const auto = useId()
  const id = given ?? auto
  const described = [hint ? `${id}-hint` : '', problem ? `${id}-problem` : ''].filter(Boolean).join(' ')
  return (
    <div class="field">
      <label for={id}>{label}</label>
      {hint ? (
        <span id={`${id}-hint`} class="hint">
          {hint}
        </span>
      ) : null}
      <textarea
        rows={3}
        {...input}
        id={id}
        value={value}
        onInput={(e) => onValue((e.currentTarget as HTMLTextAreaElement).value)}
        aria-invalid={problem ? 'true' : undefined}
        aria-describedby={described || undefined}
      />
      {problem ? (
        <span id={`${id}-problem`} class="problem">
          {problem}
        </span>
      ) : null}
    </div>
  )
}
