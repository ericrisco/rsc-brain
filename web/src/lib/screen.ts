// Every screen names itself (spec B6, ux): the browser tab says "<level-one heading> · <installation>",
// and moving to another screen puts the keyboard on its heading, so a screen reader announces where the
// person landed and Tab goes on from the top of the new screen. The first screen of a visit keeps its
// own focus (a form takes it on arrival), and so does a person who already moved on.
import { useEffect, useRef } from 'preact/hooks'

const heading = () => document.querySelector<HTMLElement>('main h1')

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
      return a !== null && a !== document.body && a !== from && a.isConnected
    }
    const land = (): boolean => {
      if (moved()) return true
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
