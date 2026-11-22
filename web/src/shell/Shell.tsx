// The frame of every signed-in screen: the rail at the left and the top bar, on one tinted ground, and the
// screen on a white sheet in all the width they leave. On a phone the frame goes: the rail is a bar across the
// top, the sections of a brain fold into a menu, and the sheet is the screen.
import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import { isCanvasRoute } from '../lib/nav.ts'
import { rail } from '../lib/rail.ts'
import { tabsMore, tabsStart } from '../lib/tabs.ts'
import { brainsResource } from '../screens/Home.tsx'
import type { Me } from '../session.ts'
import { T } from '../text.ts'
import { Dialog } from '../ui/Dialog.tsx'
import { OfflineStrip } from '../ui/states.tsx'
import { CreateBrainDialog } from './CreateBrainDialog.tsx'
import { HelpDialog } from './HelpDialog.tsx'
import { Keyboard } from './Keyboard.tsx'
import { MaintenanceStrip } from './Maintenance.tsx'
import { BrainLinks, type BrainNav, Rail } from './Rail.tsx'
import { SearchDialog } from './SearchDialog.tsx'
import { TopBar } from './TopBar.tsx'

export type { BrainNav } from './Rail.tsx'

// The brains and their numbers (the cards of home, what waits for review, the counter of the rail) are
// asked again every 30 seconds and when the tab comes back (plan §3.3).
function useFreshBrains() {
  useEffect(() => {
    const r = brainsResource()
    const again = () => {
      if (!document.hidden) void r.reload()
    }
    const every = setInterval(again, 30_000)
    document.addEventListener('visibilitychange', again)
    return () => {
      clearInterval(every)
      document.removeEventListener('visibilitychange', again)
    }
  }, [])
}

export function Shell({
  me,
  brain,
  children,
}: {
  me: Me
  brain?: BrainNav | null
  children: ComponentChildren
}) {
  const [menu, setMenu] = useState(false)
  const { path, query } = useLocation()
  // A canvas screen fills the space right of the rail and does not scroll (plan canvas-ui D4); the graph's
  // list is a page like any other.
  const canvas = isCanvasRoute(path) && query.view !== 'list'
  useFreshBrains()
  useEffect(() => setMenu(false), [path])
  // On a phone the tabs slide sideways: the current one is brought into view when a row appears, and a tab row
  // with more to the right says so (data-more) until it is scrolled to its end.
  useEffect(() => {
    const mark = (el: HTMLElement) => {
      const more = tabsMore(el.scrollLeft, el.clientWidth, el.scrollWidth)
      if (more.end) el.setAttribute('data-more', '')
      else el.removeAttribute('data-more')
      if (more.start) el.setAttribute('data-more-start', '')
      else el.removeAttribute('data-more-start')
    }
    const attach = () => {
      for (const el of document.querySelectorAll<HTMLElement>('nav.tabs:not([data-watched])')) {
        el.setAttribute('data-watched', '')
        el.addEventListener('scroll', () => mark(el), { passive: true })
        // The row can grow with no scroll (a font arrives and the tabs widen, the screen turns): look again
        // whenever the row or one of its tabs changes size.
        if (typeof ResizeObserver !== 'undefined') {
          const ro = new ResizeObserver(() => mark(el))
          ro.observe(el)
          for (const a of el.querySelectorAll('a')) ro.observe(a)
        }
        const bring = () => {
          // The current tab in view and the row starting at a tab: no word is cut at an edge.
          const box = el.getBoundingClientRect()
          const links = [...el.querySelectorAll<HTMLElement>('a')]
          const spans = links.map((a) => {
            const r = a.getBoundingClientRect()
            return { left: r.left - box.left + el.scrollLeft, right: r.right - box.left + el.scrollLeft }
          })
          const at = links.findIndex((a) => a.hasAttribute('aria-current'))
          if (at >= 0 && el.scrollWidth > el.clientWidth + 1)
            el.scrollLeft = tabsStart(spans, at, el.clientWidth, el.scrollWidth - el.clientWidth)
          mark(el)
        }
        requestAnimationFrame(() => requestAnimationFrame(bring))
        mark(el)
      }
    }
    // A table that is wider than its box slides sideways: it says so (data-more) until it is slid to its end.
    const attachTables = () => {
      for (const el of document.querySelectorAll<HTMLElement>(
        '.table-wrap:not([data-watched]), .table-scroll:not([data-watched])',
      )) {
        el.setAttribute('data-watched', '')
        const look = () => {
          if (tabsMore(el.scrollLeft, el.clientWidth, el.scrollWidth).end) el.setAttribute('data-more', '')
          else el.removeAttribute('data-more')
        }
        el.addEventListener('scroll', look, { passive: true })
        if (typeof ResizeObserver !== 'undefined') {
          const ro = new ResizeObserver(look)
          ro.observe(el)
          const table = el.querySelector('table')
          if (table) ro.observe(table)
        }
        look()
      }
    }
    attach()
    attachTables()
    const main = document.getElementById('main')
    const mo = new MutationObserver(() => {
      attach()
      attachTables()
    })
    if (main) mo.observe(main, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [path])
  return (
    <div class="frame" data-rail={rail.value} data-mode={canvas ? 'canvas' : undefined}>
      <a class="skip" href="#main">
        {T.skip}
      </a>
      <Rail me={me} brain={brain ?? null} menu={menu} onMenu={() => setMenu(true)} />
      <div class="stage">
        <TopBar brain={brain ?? null} />
        <OfflineStrip />
        <MaintenanceStrip />
        <main id="main" class="content" tabIndex={-1}>
          <div class="page">{children}</div>
        </main>
      </div>
      <Dialog
        key="sheet"
        open={menu}
        title={brain ? brain.name : T.shell.menu}
        onClose={() => setMenu(false)}
        class="sheet"
        closeLabel={T.shell.closeMenu}
      >
        {brain ? <p class="meta">{T.shell.yourRole(brain.role)}</p> : null}
        <BrainLinks brain={brain ?? null} me={me} />
      </Dialog>
      {/* Keyed: the brain's menu appearing above them must not remount an open dialog. */}
      <Keyboard key="keys" signedIn brain={brain?.slug ?? null} canInvite={me.account.canInvite} />
      <HelpDialog key="help" signedIn inBrain={Boolean(brain)} canInvite={me.account.canInvite} />
      <SearchDialog key="search" brain={brain ? { slug: brain.slug, name: brain.name } : null} />
      <CreateBrainDialog key="create" />
    </div>
  )
}
