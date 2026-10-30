// The frame of every signed-in screen (spec B6 «Mapa de la web»): the installation's name and logo, the
// search, and the account at the top; inside a brain, a side bar with its sections that folds into a
// menu on a phone.
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import { toReview } from '../lib/brains.ts'
import { applyTheme, theme } from '../lib/theme.ts'
import { brainsResource } from '../screens/Home.tsx'
import type { Me } from '../session.ts'
import { T } from '../text.ts'
import { Brand } from '../ui/Brand.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { OfflineStrip } from '../ui/states.tsx'
import { ConnectDialog } from './ConnectDialog.tsx'
import { CreateBrainDialog } from './CreateBrainDialog.tsx'
import { HelpDialog } from './HelpDialog.tsx'
import { Keyboard } from './Keyboard.tsx'
import { helpOpen, searchOpen } from './keys.ts'
import { SearchDialog } from './SearchDialog.tsx'
import { useSignOut } from './signOut.ts'

export type BrainNav = { slug: string; name: string; role: string }

function BrainLinks({ brain }: { brain: BrainNav }) {
  const { path } = useLocation()
  const base = `/b/${encodeURIComponent(brain.slug)}`
  const items = [{ href: base, label: T.shell.overview }]
  return (
    <nav class="nav" aria-label={T.shell.brainNav}>
      <a class="back" href="/">
        {T.shell.allBrains}
      </a>
      <ul>
        {items.map((i) => (
          <li key={i.href}>
            <a href={i.href} aria-current={path === i.href ? 'page' : undefined}>
              {i.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

function SideBar({ brain }: { brain: BrainNav }) {
  return (
    <>
      <p class="brain-name">{brain.name}</p>
      <p class="brain-role meta">{T.shell.yourRole(brain.role)}</p>
      <BrainLinks brain={brain} />
    </>
  )
}

function AccountMenu({ me }: { me: Me }) {
  const [open, setOpen] = useState(false)
  const { signOut, leaving, failed } = useSignOut()
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: Event) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        button.current?.focus()
      }
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])
  const name = me.account.name
  return (
    <div class="account" ref={box}>
      <button
        ref={button}
        type="button"
        class="account-button"
        aria-expanded={open ? 'true' : 'false'}
        aria-controls="account-menu"
        onClick={() => setOpen(!open)}
      >
        <span class="initial" aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span class="who-name">{name}</span>
        <span class="sr-only">{T.shell.account}</span>
      </button>
      {open ? (
        <div class="account-menu" id="account-menu">
          <div class="who">
            <p class="meta">{T.shell.signedInAs}</p>
            <p>{name}</p>
            {me.account.email ? <p class="meta">{me.account.email}</p> : null}
          </div>
          {me.account.canInvite ? (
            <a href="/people" onClick={() => setOpen(false)}>
              <span>{T.shell.people}</span>
            </a>
          ) : null}
          <button
            type="button"
            class="keyboard-only"
            onClick={() => {
              setOpen(false)
              helpOpen.value = true
            }}
          >
            <span>{T.shell.shortcuts}</span>
            <kbd>?</kbd>
          </button>
          <button
            type="button"
            aria-pressed={theme.value === 'light' ? 'true' : 'false'}
            onClick={() => applyTheme(theme.value === 'light' ? 'dark' : 'light')}
          >
            <span>{T.shell.themeLight}</span>
            <span class="meta">{theme.value === 'light' ? 'on' : 'off'}</span>
          </button>
          <button type="button" onClick={() => void signOut()} aria-busy={leaving ? 'true' : undefined}>
            <span>{leaving ? T.shell.signingOut : T.shell.signOut}</span>
          </button>
          {failed ? (
            <p class="menu-alert" role="alert">
              {T.shell.signOutFailed}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// The proposals waiting for me, across my brains (spec B6: «el aviso de propuestas pendientes»). Asked
// again every 30 seconds and when the tab comes back (plan §3.3); shown only when something waits.
function ToReview() {
  const r = brainsResource()
  useEffect(() => {
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
  const brains = r.data.value?.brains
  if (!brains) return null
  const { count, href } = toReview(brains)
  if (!count) return null
  return (
    <a class="to-review" href={href} aria-label={T.shell.toReview(count)}>
      <span class="dot" aria-hidden="true" />
      <span class="long">{T.shell.toReview(count)}</span>
      <span class="short">{T.shell.toReviewShort(count)}</span>
      <span class="tiny">{count}</span>
    </a>
  )
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
  const { path } = useLocation()
  useEffect(() => setMenu(false), [path])
  return (
    <div class="frame">
      <a class="skip" href="#main">
        {T.skip}
      </a>
      <header class="topbar">
        {brain ? (
          <button
            type="button"
            class="button quiet only-narrow"
            aria-expanded={menu ? 'true' : 'false'}
            onClick={() => setMenu(true)}
          >
            {T.shell.menu}
          </button>
        ) : null}
        <Brand />
        <div class="middle">
          <button
            type="button"
            class="searchbox"
            onClick={() => (searchOpen.value = true)}
            aria-keyshortcuts="Meta+K Control+K"
          >
            <span class="label">{T.shell.searchHint}</span>
            <span class="short">{T.shell.search}</span>
            <kbd>⌘K</kbd>
          </button>
        </div>
        <div class="end">
          <ToReview />
          <AccountMenu me={me} />
        </div>
      </header>
      <OfflineStrip />
      <div class={`body${brain ? '' : ' no-side'}`}>
        {brain ? (
          <aside class="sidebar">
            <SideBar brain={brain} />
          </aside>
        ) : null}
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
      <Keyboard key="keys" signedIn brain={brain?.slug ?? null} />
      <HelpDialog key="help" signedIn inBrain={Boolean(brain)} />
      <SearchDialog key="search" />
      <ConnectDialog key="connect" />
      <CreateBrainDialog key="create" />
    </div>
  )
}
