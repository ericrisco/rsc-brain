// A button that cannot be pressed twice while its action runs, and that says why it is off (spec B6
// «Pendiente», «Sin conexión»). It stays focusable when off, so the reason can be found by keyboard.
import type { ComponentChildren, JSX } from 'preact'
import { useId } from 'preact/hooks'

type Props = Omit<JSX.HTMLAttributes<HTMLButtonElement>, 'disabled'> & {
  kind?: 'primary' | 'secondary' | 'quiet'
  pending?: boolean
  pendingLabel?: string
  // Why it cannot be used now; shown next to it.
  blocked?: string | null
  type?: 'button' | 'submit'
  children: ComponentChildren
}

export function Button({
  kind = 'secondary',
  pending,
  pendingLabel,
  blocked,
  type = 'button',
  children,
  onClick,
  ...rest
}: Props) {
  const reasonId = useId()
  const off = Boolean(pending || blocked)
  return (
    <>
      <button
        {...rest}
        type={type}
        class={`button ${kind}`}
        aria-disabled={off ? 'true' : undefined}
        aria-busy={pending ? 'true' : undefined}
        aria-describedby={blocked && !pending ? reasonId : undefined}
        onClick={(e) => {
          if (off) {
            e.preventDefault()
            return
          }
          onClick?.(e)
        }}
      >
        {pending && pendingLabel ? pendingLabel : children}
      </button>
      {blocked && !pending ? (
        <span id={reasonId} class="reason">
          {blocked}
        </span>
      ) : null}
    </>
  )
}
