// Where the keyboard goes once a screen has drawn what an action changed (the graph screen: after Focus, Leave
// focus, opening a group, clearing the filters). Never left waiting: it lands on its place as soon as that is
// drawn; once nothing is loading, or after `wait` ms, on the fallback instead; and any key or click of the
// person's own cancels the wait, so it never takes the keyboard back later.

type Focusable = { focus: (o?: { preventScroll?: boolean }) => void }
export type LandingDoc = {
  querySelector: (selector: string) => Focusable | null
  addEventListener: (type: string, f: () => void, capture?: boolean) => void
  removeEventListener: (type: string, f: () => void, capture?: boolean) => void
}

export type Landing = {
  // The place the keyboard should go next (a CSS selector).
  want: (selector: string) => void
  // Called after each render: lands when the place is there; when it is not and nothing is loading, falls back.
  land: (loading: boolean) => void
  pending: () => string | null
  dispose: () => void
}

export function landing(doc: LandingDoc, fallback: string, wait = 2000): Landing {
  let pending: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const resolve = (late: boolean, loading: boolean) => {
    const sel = pending
    if (!sel) return
    const el = doc.querySelector(sel)
    if (el) {
      pending = null
      stop()
      el.focus({ preventScroll: sel === '#graph-focus' })
      return
    }
    if (loading && !late) return
    pending = null
    stop()
    doc.querySelector(fallback)?.focus({ preventScroll: true })
  }
  const cancel = () => {
    pending = null
    stop()
  }
  doc.addEventListener('keydown', cancel, true)
  doc.addEventListener('pointerdown', cancel, true)
  return {
    want: (selector) => {
      stop()
      pending = selector
      timer = setTimeout(() => resolve(true, true), wait)
    },
    land: (loading) => resolve(false, loading),
    pending: () => pending,
    dispose: () => {
      stop()
      doc.removeEventListener('keydown', cancel, true)
      doc.removeEventListener('pointerdown', cancel, true)
    },
  }
}
