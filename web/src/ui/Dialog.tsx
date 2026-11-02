// A native modal dialog (DESIGN.md: «Los diálogos utilizan el elemento nativo para foco y cierre»): the
// browser traps focus, Esc closes it, and focus goes back to what opened it.
import type { ComponentChildren } from 'preact'
import { useId, useLayoutEffect, useRef } from 'preact/hooks'
import { T } from '../text.ts'

export function Dialog({
  open,
  title,
  onClose,
  children,
  class: cls,
  closeLabel = T.help.close,
  locked = false,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ComponentChildren
  class?: string
  closeLabel?: string
  // While what it started runs (a restore): Esc, the backdrop and Close do not close it, so its answer is seen.
  locked?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  // In the same frame as the render: a key pressed right after closing must not find the dialog open.
  useLayoutEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the backdrop click is a pointer extra; Esc closes it natively
    <dialog
      ref={ref}
      class={cls}
      aria-labelledby={id}
      onCancel={(e) => {
        if (locked) e.preventDefault()
      }}
      onClose={() => {
        const d = ref.current
        // The browser's "close" is queued: one that arrives after the dialog opened again is stale.
        if (!d || d.open) return
        // Locked (a restore runs): a second Esc may close it anyway (close watchers); it opens again at once, with
        // the keyboard on its heading, so what it started is seen to the end.
        if (locked && open) {
          d.showModal()
          document.getElementById(id)?.focus()
          return
        }
        onClose()
      }}
      onClick={(e) => {
        // A click on the backdrop (the dialog itself, outside its content) closes it.
        if (e.target === ref.current && !locked) ref.current?.close()
      }}
    >
      {open ? (
        <>
          <div class="dialog-head">
            <h2 id={id} tabIndex={-1}>
              {title}
            </h2>
            <button
              type="button"
              class="button quiet"
              aria-disabled={locked ? 'true' : undefined}
              onClick={() => {
                if (!locked) ref.current?.close()
              }}
            >
              {closeLabel}
            </button>
          </div>
          <div class="dialog-body">{children}</div>
        </>
      ) : null}
    </dialog>
  )
}
