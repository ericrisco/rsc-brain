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
  // How many proposals wait in this brain, beside its section (from the brains and their numbers).
  const waiting =
    brainsResource().data.value?.brains.find((b) => b.slug === brain.slug)?.stats.pendingProposals ?? 0
  const items = [
    { href: base, label: T.shell.overview, here: path === base, keys: 'g o' },
    // A proposal is in the proposals.
    {
      href: `${base}/proposals`,
      label: T.shell.proposals,
      here: path === `${base}/proposals` ? true : path.startsWith(`${base}/proposals/`) ? 'inside' : false,
      keys: 'g r',
      count: waiting,
    },
    // A page of the wiki is in the wiki.
    {
      href: `${base}/wiki`,
      label: T.shell.wiki,
      here: path === `${base}/wiki` ? true : path.startsWith(`${base}/pages/`) ? 'inside' : false,
      keys: 'g w',
    },
    { href: `${base}/wiki/decisions`, label: T.shell.decisions, here: path === `${base}/wiki/decisions` },
    { href: `${base}/wiki/log`, label: T.shell.log, here: path === `${base}/wiki/log` },
    { href: `${base}/wiki/graph`, label: T.shell.graph, here: path === `${base}/wiki/graph` },
    // Every screen of the journal is in the journal.
    {
      href: `${base}/journal`,
      label: T.shell.journal,
      here: path === `${base}/journal` ? true : path.startsWith(`${base}/journal/`) ? 'inside' : false,
      keys: 'g j',
    },
    { href: `${base}/activity`, label: T.shell.activity, here: path === `${base}/activity` },
    { href: `${base}/health`, label: T.shell.health, here: path === `${base}/health` },
    // Only curators change a brain's settings (B4); the others are not offered the page.
    ...(brain.role === 'curator'
      ? [{ href: `${base}/settings`, label: T.shell.settings, here: path === `${base}/settings` }]
      : []),
  ]
  return (
    <nav class="nav" aria-label={T.shell.brainNav}>
      <a class="back" href="/">
        {T.shell.allBrains}
      </a>
      <ul>
        {items.map((i) => (
          <li key={i.href}>
            <a
              href={i.href}
              aria-current={i.here === 'inside' ? 'true' : i.here ? 'page' : undefined}
              aria-keyshortcuts={'keys' in i ? i.keys : undefined}
            >
              {i.label}
              {'count' in i && i.count ? (
                <>
                  {' '}
                  <span class="nav-count">
                    {i.count}
                    <span class="sr-only"> {T.shell.pending}</span>
                  </span>
                </>
              ) : null}
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
          <a href="/profile" onClick={() => setOpen(false)}>
            <span>{T.shell.profile}</span>
          </a>
          <a href="/connect" onClick={() => setOpen(false)}>
            <span>{T.shell.connect}</span>
          </a>
          {me.account.canInvite ? (
            <a href="/people" onClick={() => setOpen(false)}>
              <span>{T.shell.people}</span>
            </a>
          ) : null}
          {me.account.isAdmin ? (
            <a href="/admin/people" onClick={() => setOpen(false)}>
              <span>{T.shell.admin}</span>
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

// The brains and their numbers (the cards of home, what waits for review, the counter of the top bar) are
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

// What waits for me to review, in the top bar: the proposals of the brains I curate; with one brain
// waiting it leads to its inbox, with more to home, where each card says how many.
function ToReview() {
  const { path } = useLocation()
  const brains = brainsResource().data.value?.brains
  if (!brains) return null
  const { count, href } = toReview(brains)
  if (!count) return null
  return (
    <a class="top-link to-review" href={href} aria-current={path === href ? 'page' : undefined}>
      <span class="to-review-n">{count}</span>
      <span class="rest">
        {' '}
        <span class="wide-only">{count === 1 ? 'proposal' : 'proposals'} </span>
        to review
      </span>
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
  useFreshBrains()
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
          {me.account.canInvite ? (
            <a
              class="top-link"
              href="/people"
              aria-current={path === '/people' ? 'page' : undefined}
              aria-keyshortcuts="g p"
            >
              {T.shell.people}
            </a>
          ) : null}
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
      <Keyboard key="keys" signedIn brain={brain?.slug ?? null} canInvite={me.account.canInvite} />
      <HelpDialog key="help" signedIn inBrain={Boolean(brain)} canInvite={me.account.canInvite} />
      <SearchDialog key="search" brain={brain ? { slug: brain.slug, name: brain.name } : null} />
      <CreateBrainDialog key="create" />
    </div>
  )
}
