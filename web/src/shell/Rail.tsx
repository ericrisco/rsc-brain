// The rail at the left of every signed-in screen: the logo, the brain switcher, the sections of the brain, and
// at the foot what waits for review, People, help, the account and the button that folds it. Open it is 228px
// with the names (the first time, and until the person folds it); folded it is 56px of icons whose names stay
// in the page, hidden to the eye and shown as a tooltip on hover or focus (Esc hides it). The search is in the
// top bar. On a phone it is the bar across the top, with the search as an icon, and the sections fold into a
// menu.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import { toReview } from '../lib/brains.ts'
import { CHOICES, choice, chooseMode } from '../lib/mode.ts'
import { foldRail, isTablet, rail, startRail, TABLET, toggleRail } from '../lib/rail.ts'
import { brainsResource } from '../screens/Home.tsx'
import type { Me } from '../session.ts'
import { T } from '../text.ts'
import { Brand } from '../ui/Brand.tsx'
import { Icon, type IconName } from '../ui/icons.tsx'
import { usePopover } from '../ui/usePopover.ts'
import { createOpen } from './dialogs.ts'
import { helpOpen, searchOpen } from './keys.ts'
import { useSignOut } from './signOut.ts'

export type BrainNav = { slug: string; name: string; role: string }

type Item = {
  href: string
  label: string
  icon: IconName
  here: boolean | 'inside'
  keys?: string
  count?: number
}

function itemsOf(brain: BrainNav, path: string, waiting: number): Item[] {
  const base = `/b/${encodeURIComponent(brain.slug)}`
  const under = (p: string): boolean | 'inside' =>
    path === p ? true : path.startsWith(`${p}/`) ? 'inside' : false
  return [
    { href: base, label: T.shell.overview, icon: 'overview', here: path === base, keys: 'g o' },
    // A proposal is in the proposals.
    {
      href: `${base}/proposals`,
      label: T.shell.proposals,
      icon: 'proposals',
      here: under(`${base}/proposals`),
      keys: 'g r',
      count: waiting,
    },
    // A page of the wiki is in the wiki.
    {
      href: `${base}/wiki`,
      label: T.shell.wiki,
      icon: 'wiki',
      here: path === `${base}/wiki` ? true : path.startsWith(`${base}/pages/`) ? 'inside' : false,
      keys: 'g w',
    },
    {
      href: `${base}/wiki/decisions`,
      label: T.shell.decisions,
      icon: 'decisions',
      here: path === `${base}/wiki/decisions`,
    },
    { href: `${base}/wiki/log`, label: T.shell.log, icon: 'log', here: path === `${base}/wiki/log` },
    { href: `${base}/wiki/graph`, label: T.shell.graph, icon: 'graph', here: path === `${base}/wiki/graph` },
    // Every screen of the journal is in the journal.
    {
      href: `${base}/journal`,
      label: T.shell.journal,
      icon: 'journal',
      here: under(`${base}/journal`),
      keys: 'g j',
    },
    {
      href: `${base}/activity`,
      label: T.shell.activity,
      icon: 'activity',
      here: path === `${base}/activity`,
    },
    { href: `${base}/health`, label: T.shell.health, icon: 'health', here: path === `${base}/health` },
    // Only curators change a brain's settings (B4); the others are not offered the page.
    ...(brain.role === 'curator'
      ? [
          {
            href: `${base}/settings`,
            label: T.shell.settings,
            icon: 'settings' as const,
            here: under(`${base}/settings`),
          },
        ]
      : []),
  ]
}

function RailLink({ item }: { item: Item }) {
  return (
    <a
      class="rail-item"
      href={item.href}
      aria-current={item.here === 'inside' ? 'true' : item.here ? 'page' : undefined}
      aria-keyshortcuts={item.keys}
    >
      <Icon name={item.icon} />
      <span class="rail-label">
        {item.label}
        {item.count ? (
          <span class="sr-only">
            {' '}
            {item.count} {T.shell.pending}
          </span>
        ) : null}
      </span>
      {item.count ? (
        <span class="rail-badge" aria-hidden="true">
          {item.count}
        </span>
      ) : null}
    </a>
  )
}

// The sections of the brain, and the way back to all brains. Also the content of the menu on a phone.
// Outside a brain (Administration, People, all brains) the phone's menu, which is given `me`, has no sections
// to hold, so it holds the places a person goes from there. The rail on a wide screen has them elsewhere.
export function BrainLinks({ brain, me }: { brain: BrainNav | null; me?: Me }) {
  const { path } = useLocation()
  // How many proposals wait in this brain, beside its section (from the brains and their numbers).
  const waiting = brain
    ? (brainsResource().data.value?.brains.find((b) => b.slug === brain.slug)?.stats.pendingProposals ?? 0)
    : 0
  const home: Item = { href: '/', label: T.shell.allBrains, icon: 'home', here: path === '/' }
  return (
    <nav class="rail-nav" aria-label={brain ? T.shell.brainNav : T.shell.mainNav}>
      <ul>
        <li>
          <RailLink item={home} />
        </li>
        {!brain && me?.account.canInvite ? (
          <li>
            <RailLink
              item={{ href: '/people', label: T.shell.people, icon: 'people', here: path === '/people' }}
            />
          </li>
        ) : null}
        {!brain && me?.account.isAdmin ? (
          <li>
            <RailLink
              item={{
                href: '/admin/people',
                label: T.shell.admin,
                icon: 'admin',
                here: path.startsWith('/admin'),
              }}
            />
          </li>
        ) : null}
      </ul>
      {brain ? (
        <ul class="rail-group">
          {itemsOf(brain, path, waiting).map((i) => (
            <li key={i.href}>
              <RailLink item={i} />
            </li>
          ))}
        </ul>
      ) : null}
    </nav>
  )
}

// The brain this screen is in, and the others a click away.
function BrainSwitcher({ brain, me }: { brain: BrainNav; me: Me }) {
  const { open, setOpen, box, button } = usePopover()
  const brains = brainsResource().data.value?.brains ?? []
  return (
    <div class="switcher" ref={box}>
      <button
        ref={button}
        type="button"
        class="rail-item switcher-button"
        aria-expanded={open ? 'true' : 'false'}
        aria-controls="brain-switcher"
        onClick={() => setOpen(!open)}
      >
        <span class="brain-avatar" aria-hidden="true">
          {brain.name.slice(0, 1).toUpperCase()}
        </span>
        <span class="rail-label">
          <span class="brain-name">{brain.name}</span>
          <span class="brain-role">{T.shell.yourRole(brain.role)}</span>
          <span class="sr-only">, {T.shell.switchBrain.toLowerCase()}</span>
        </span>
        <Icon name="updown" size={16} class="rail-end" />
      </button>
      {open ? (
        <div class="popover switcher-menu" id="brain-switcher">
          <p class="popover-title">{T.shell.brains}</p>
          <ul>
            {brains.map((b) => (
              <li key={b.slug}>
                <a
                  href={`/b/${encodeURIComponent(b.slug)}`}
                  aria-current={b.slug === brain.slug ? 'page' : undefined}
                  onClick={() => setOpen(false)}
                >
                  <span class="brain-avatar small" aria-hidden="true">
                    {b.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span class="grow">{b.name}</span>
                  {b.slug === brain.slug ? <Icon name="check" size={16} /> : null}
                </a>
              </li>
            ))}
          </ul>
          <div class="popover-foot">
            <a href="/" onClick={() => setOpen(false)}>
              <Icon name="home" size={16} />
              <span>{T.shell.allBrains}</span>
            </a>
            {me.account.canCreateBrains ? (
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  createOpen.value = true
                }}
              >
                <Icon name="plus" size={16} />
                <span>{T.shell.newBrain}</span>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function AccountMenu({ me }: { me: Me }) {
  const { open, setOpen, box, button } = usePopover()
  const { signOut, leaving, failed } = useSignOut()
  const name = me.account.name
  return (
    <div class="account" ref={box}>
      <button
        ref={button}
        type="button"
        class="rail-item account-button"
        aria-expanded={open ? 'true' : 'false'}
        aria-controls="account-menu"
        onClick={() => setOpen(!open)}
      >
        <span class="initial" aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span class="rail-label">
          <span class="who-name">{name}</span>
          <span class="sr-only">{T.shell.account}</span>
        </span>
      </button>
      {open ? (
        <div class="popover account-menu" id="account-menu">
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
          <fieldset class="mode-picker">
            <legend class="meta">{T.shell.mode}</legend>
            <div class="mode-choices">
              {CHOICES.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-pressed={choice.value === c ? 'true' : 'false'}
                  onClick={() => chooseMode(c)}
                >
                  {T.shell.modes[c]}
                </button>
              ))}
            </div>
          </fieldset>
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

// What waits for me to review: the proposals of the brains I curate; with one brain waiting it leads to
// its inbox, with more to home, where each card says how many.
function ToReview({ brain }: { brain: BrainNav | null }) {
  const { path } = useLocation()
  const brains = brainsResource().data.value?.brains
  if (!brains) return null
  const { count, href } = toReview(brains)
  if (!count) return null
  // In the one brain that holds all of them, its own Proposals item already says so: not twice.
  if (brain && brains.find((b) => b.slug === brain.slug)?.stats.pendingProposals === count) return null
  return (
    <a class="rail-item to-review" href={href} aria-current={path === href ? 'page' : undefined}>
      <Icon name="review" />
      <span class="rail-label">{T.shell.toReview(count)}</span>
      <span class="rail-badge" aria-hidden="true">
        {count}
      </span>
    </a>
  )
}

// Esc hides the tooltip under the pointer or the focus until the person moves to another item (WCAG
// 1.4.13: dismissible without moving).
function useTips() {
  const [off, setOff] = useState(false)
  const at = useRef<Element | null>(null)
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const hovered = document.querySelector('.rail .rail-item:hover')
      at.current = hovered ?? document.activeElement
      setOff(true)
    }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [])
  const moved = (e: Event) => {
    const item = (e.target as Element | null)?.closest?.('.rail-item') ?? null
    if (item !== at.current) setOff(false)
  }
  return { off, moved }
}

// On a tablet the open rail lies over the screen: it closes on a move to another screen, on Esc, on a click
// outside it and when the keyboard leaves it (review R2, A2). Crossing into or out of a tablet's width
// starts the rail again.
function useTabletRail(path: string, open: boolean) {
  useEffect(() => {
    if (isTablet()) foldRail()
  }, [path])
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia(TABLET)
    const changed = () => startRail()
    mq.addEventListener('change', changed)
    return () => mq.removeEventListener('change', changed)
  }, [])
  useLayoutEffect(() => {
    if (!open || !isTablet()) return
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) foldRail()
    }
    const outside = (e: Event) => {
      if (!(e.target as Element | null)?.closest?.('#rail')) foldRail()
    }
    document.addEventListener('keydown', esc)
    document.addEventListener('pointerdown', outside)
    // The keyboard leaving the rail (Tab past its last stop) folds it too (review A2).
    document.addEventListener('focusin', outside)
    return () => {
      document.removeEventListener('keydown', esc)
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
    }
  }, [open])
}

export function Rail({
  me,
  brain,
  menu,
  onMenu,
}: {
  me: Me
  brain: BrainNav | null
  menu: boolean
  onMenu: () => void
}) {
  const { path } = useLocation()
  const open = rail.value === 'open'
  const tips = useTips()
  useTabletRail(path, open)
  return (
    <header
      class="rail"
      id="rail"
      data-tips={tips.off ? 'off' : undefined}
      onPointerOver={tips.moved}
      onFocusIn={tips.moved}
    >
      <div class="rail-head">
        <button
          type="button"
          class="button quiet only-narrow"
          aria-expanded={menu ? 'true' : 'false'}
          onClick={onMenu}
        >
          {T.shell.menu}
        </button>
        <Brand />
      </div>
      <div class="rail-tools">
        <button
          type="button"
          class="rail-item searchbox only-narrow"
          onClick={() => (searchOpen.value = true)}
          aria-keyshortcuts="Meta+K Control+K"
        >
          <Icon name="search" />
          <span class="rail-label">{T.shell.searchHint}</span>
        </button>
        {brain ? <BrainSwitcher brain={brain} me={me} /> : null}
      </div>
      <BrainLinks brain={brain} />
      <div class="rail-foot">
        <ToReview brain={brain} />
        {me.account.canInvite ? (
          <a
            class="rail-item"
            href="/people"
            aria-current={path === '/people' ? 'page' : undefined}
            aria-keyshortcuts="g p"
          >
            <Icon name="people" />
            <span class="rail-label">{T.shell.people}</span>
          </a>
        ) : null}
        <button
          type="button"
          class="rail-item rail-help keyboard-only"
          aria-keyshortcuts="?"
          onClick={() => (helpOpen.value = true)}
        >
          <Icon name="help" />
          <span class="rail-label">{T.shell.help}</span>
          <kbd class="rail-end">?</kbd>
        </button>
        <AccountMenu me={me} />
        <button
          type="button"
          class="rail-item rail-toggle"
          aria-expanded={open ? 'true' : 'false'}
          aria-controls="rail"
          onClick={() => toggleRail()}
        >
          <Icon name="panel" />
          <span class="rail-label">{open ? T.shell.foldRail : T.shell.expandRail}</span>
        </button>
      </div>
    </header>
  )
}
