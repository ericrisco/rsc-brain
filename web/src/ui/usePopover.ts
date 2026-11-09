// A menu that opens under its button (the account menu, the brain switcher): a press outside closes it,
// and Esc closes it giving the focus back to the button.
import { useEffect, useRef, useState } from 'preact/hooks'

export function usePopover<B extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false)
  const box = useRef<B>(null)
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: Event) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Heard first (capture) and spent: what holds the menu (an open rail) does not close as well.
        e.preventDefault()
        setOpen(false)
        button.current?.focus()
      }
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc, true)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', esc, true)
    }
  }, [open])
  return { open, setOpen, box, button }
}
