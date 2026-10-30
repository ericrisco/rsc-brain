// Every screen names itself (spec B6, ux): the browser tab says "<level-one heading> · <installation>",
// and moving to another screen puts the keyboard on its heading, so a screen reader announces where the
// person landed and Tab goes on from the top of the new screen. A screen whose job is one field (sign
// in: the email) marks it with data-start, and the keyboard goes there instead, as on a fresh load. The
// first screen of a visit keeps its own focus (a form takes it on arrival), and so does a person who
// already moved on.
import { useEffect, useRef } from 'preact/hooks'

const heading = () => document.querySelector<HTMLElement>('main h1')

// A place where the person types: the keyboard there is theirs.
export const isField = (el: Element | null): boolean =>
  !!el &&
  (el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    (el instanceof HTMLInputElement &&
      !['button', 'submit', 'reset', 'checkbox', 'radio'].includes(el.type)) ||
    (el as HTMLElement).isContentEditable)

// Focus on arrival, unless the person is already typing somewhere (a screen mounted again by a late
// redirect must not take the keyboard from the password).
export function focusOnArrival(el: HTMLElement | null): void {
  if (el && !isField(document.activeElement)) el.focus()
}

export function useScreenTitle(path: string, installation: string): void {
  // A screen has been shown (its heading appeared): from then on, a new path is a move.
  const shown = useRef(false)
  const last = useRef(path)
  useEffect(() => {
    const update = () => {
      const h = heading()
      if (h) shown.current = true
      const text = h?.textContent?.trim()
      const want = text ? `${text} · ${installation}` : installation
      if (document.title !== want) document.title = want
    }
    update()
    const watch = new MutationObserver(update)
    watch.observe(document.body, { childList: true, subtree: true, characterData: true })
    return () => watch.disconnect()
  }, [installation])

  useEffect(() => {
    if (last.current === path) return
    last.current = path
    if (!shown.current) return
    const from = document.activeElement
    const moved = () => {
      const a = document.activeElement
      // Someone typing in a field keeps it, whatever moved the screen meanwhile (a late redirect).
      if (a?.isConnected && isField(a)) return true
      return a !== null && a !== document.body && a !== from && a.isConnected
    }
    const land = (): boolean => {
      if (moved()) return true
      const start = document.querySelector<HTMLElement>('main [data-start]')
      if (start) {
        start.focus()
        return true
      }
      const h = heading()
      if (!h) return false
      if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1')
      h.focus()
      return true
    }
    if (land()) return
    // The heading comes with the data (a brain loads): wait for it, a few seconds at most.
    const watch = new MutationObserver(() => {
      if (land()) watch.disconnect()
    })
    watch.observe(document.body, { childList: true, subtree: true })
    const stop = setTimeout(() => watch.disconnect(), 5000)
    return () => {
      watch.disconnect()
      clearTimeout(stop)
    }
  }, [path])
}
