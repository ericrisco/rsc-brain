// The frame of every signed-in screen (spec B6 «Mapa de la web», plan canvas-ui D1–D3): the rail at the
// left, and the screen in all the width it leaves. On a phone the rail is a bar across the top and the
// sections of a brain fold into a menu.
import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import { isCanvasRoute } from '../lib/nav.ts'
import { rail } from '../lib/rail.ts'
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
  return (
    <div class="frame" data-rail={rail.value} data-mode={canvas ? 'canvas' : undefined}>
      <a class="skip" href="#main">
        {T.skip}
      </a>
      <Rail me={me} brain={brain ?? null} menu={menu} onMenu={() => setMenu(true)} />
      <div class="stage">
        <OfflineStrip />
        <MaintenanceStrip />
        <main id="main" class="content" tabIndex={-1}>
          <div class="page">{children}</div>
        </main>
      </div>
      {brain ? (
        <Dialog
          key="sheet"
          open={menu}
          title={brain.name}
          onClose={() => setMenu(false)}
          class="sheet"
          closeLabel={T.shell.closeMenu}
        >
          <p class="meta">{T.shell.yourRole(brain.role)}</p>
          <BrainLinks brain={brain} />
        </Dialog>
      ) : null}
      {/* Keyed: the brain's menu appearing above them must not remount an open dialog. */}
      <Keyboard key="keys" signedIn brain={brain?.slug ?? null} canInvite={me.account.canInvite} />
      <HelpDialog key="help" signedIn inBrain={Boolean(brain)} canInvite={me.account.canInvite} />
      <SearchDialog key="search" brain={brain ? { slug: brain.slug, name: brain.name } : null} />
      <CreateBrainDialog key="create" />
    </div>
  )
}
