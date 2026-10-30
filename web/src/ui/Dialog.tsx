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
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ComponentChildren
  class?: string
  closeLabel?: string
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
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop (the dialog itself, outside its content) closes it.
        if (e.target === ref.current) ref.current?.close()
      }}
    >
      {open ? (
        <>
          <div class="dialog-head">
            <h2 id={id}>{title}</h2>
            <button type="button" class="button quiet" onClick={() => ref.current?.close()}>
              {closeLabel}
            </button>
          </div>
          <div class="dialog-body">{children}</div>
        </>
      ) : null}
    </dialog>
  )
}
