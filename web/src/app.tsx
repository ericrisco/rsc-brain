// The routes of the web (spec B6 «Mapa de la web»). Before a session: sign in, first run, invitation,
// reset. With one: the shell around home and each brain. Until the first-time setup is done, everything
// leads to it.

import { useEffect, useRef } from 'preact/hooks'
import { LocationProvider, Route, Router, useLocation } from 'preact-iso'
import { api, goTo } from './api/index.ts'
import { signInPath } from './lib/nav.ts'
import { useScreenTitle } from './lib/screen.ts'
import { Activity } from './screens/Activity.tsx'
import { Brain, brainResource } from './screens/Brain.tsx'
import { HealthScreen } from './screens/Health.tsx'
import { Home } from './screens/Home.tsx'
import { Invite } from './screens/Invite.tsx'
import { JournalCorrect } from './screens/journal/Correct.tsx'
import { JournalEntry } from './screens/journal/Entry.tsx'
import { JournalConflicts, JournalForgotten, JournalToReview } from './screens/journal/Lists.tsx'
import { JournalSession } from './screens/journal/Session.tsx'
import { JournalSessions } from './screens/journal/Sessions.tsx'
import { NotFound } from './screens/NotFound.tsx'
import { People } from './screens/People.tsx'
import { ProposalsInbox } from './screens/proposals/Inbox.tsx'
import { ProposalScreen } from './screens/proposals/Proposal.tsx'
import { Reset } from './screens/Reset.tsx'
import { Setup } from './screens/Setup.tsx'
import { SignIn } from './screens/SignIn.tsx'
import { WikiDecisions } from './screens/wiki/Decisions.tsx'
import { WikiGraph } from './screens/wiki/Graph.tsx'
import { WikiLog } from './screens/wiki/Log.tsx'
import { WikiMap } from './screens/wiki/Map.tsx'
import { screenKey, WikiPage } from './screens/wiki/Page.tsx'
import { branding, installationName, isSignedOut, type Me, me } from './session.ts'
import { Door } from './shell/Door.tsx'
import { type BrainNav, Shell } from './shell/Shell.tsx'
import { ErrorState, Skeleton } from './ui/states.tsx'

const DOORS = ['/sign-in', '/setup', '/invite', '/reset']

// The brain an address is in; undefined when its name is not a valid escape (a broken link), which is
// a page that does not exist, never a blank page.
function brainOf(path: string): string | null | undefined {
  const m = /^\/b\/([^/]+)/.exec(path)
  if (!m?.[1]) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return undefined
  }
}

// Every part of an address must be a valid escape; one that is not is a broken link.
function decodable(path: string): boolean {
  try {
    decodeURIComponent(path)
    return true
  } catch {
    return false
  }
}

function BrainPage({ slug }: { slug?: string }) {
  return <Brain slug={slug ?? ''} />
}

// Each screen of a brain is drawn again from scratch when its brain or page changes (its state belongs
// to the one it shows).
function MapPage({ slug }: { slug?: string }) {
  return <WikiMap key={slug} slug={slug ?? ''} />
}
function DecisionsPage({ slug }: { slug?: string }) {
  return <WikiDecisions key={slug} slug={slug ?? ''} />
}
function GraphPage({ slug }: { slug?: string }) {
  return <WikiGraph key={slug} slug={slug ?? ''} />
}
function LogPage({ slug }: { slug?: string }) {
  return <WikiLog key={slug} slug={slug ?? ''} />
}
function PagePage({ slug, address }: { slug?: string; address?: string }) {
  return <WikiPage key={screenKey(slug ?? '', address ?? '')} slug={slug ?? ''} address={address ?? ''} />
}

function SessionsPage({ slug }: { slug?: string }) {
  return <JournalSessions key={slug} slug={slug ?? ''} />
}
function SessionPage({ slug, id }: { slug?: string; id?: string }) {
  return <JournalSession key={`${slug}/${id}`} slug={slug ?? ''} id={id ?? ''} />
}
function EntryPage({ slug, id }: { slug?: string; id?: string }) {
  return <JournalEntry key={`${slug}/${id}`} slug={slug ?? ''} id={id ?? ''} />
}
function ConflictsPage({ slug }: { slug?: string }) {
  return <JournalConflicts key={slug} slug={slug ?? ''} />
}
function ForgottenPage({ slug }: { slug?: string }) {
  return <JournalForgotten key={slug} slug={slug ?? ''} />
}
function ToReviewPage({ slug }: { slug?: string }) {
  return <JournalToReview key={slug} slug={slug ?? ''} />
}
function CorrectPage({ slug }: { slug?: string }) {
  return <JournalCorrect key={slug} slug={slug ?? ''} />
}

function InboxPage({ slug }: { slug?: string }) {
  return <ProposalsInbox key={slug} slug={slug ?? ''} />
}
function ProposalPage({ slug, id }: { slug?: string; id?: string }) {
  return <ProposalScreen key={`${slug}/${id}`} slug={slug ?? ''} id={id ?? ''} />
}

function ActivityPage({ slug }: { slug?: string }) {
  return <Activity key={slug} slug={slug ?? ''} />
}
function HealthPage({ slug }: { slug?: string }) {
  return <HealthScreen key={slug} slug={slug ?? ''} />
}

function SignedIn() {
  const { path, url, route } = useLocation()
  const who = me()
  const slug = brainOf(path)
  // The brain is asked for only once the person is known (a 401 there would race the one of /v1/me).
  const brain = slug && who.data.value ? brainResource(slug).data.value?.brain : undefined
  const broken = slug === undefined || !decodable(path)
  const nav: BrainNav | null = brain ? { slug: brain.slug, name: brain.name, role: brain.role } : null
  useEffect(() => {
    if (isSignedOut(who.error.value)) route(signInPath(url), true)
  }, [who.error.value])
  // Screens already loaded show what they hold without asking the server again; so on every move the
  // session is checked (one small GET /v1/me), and one revoked meanwhile leads to sign-in at once,
  // instead of after the next thing the person sends. Not on arrival: the first "who am I" does it.
  const arrived = useRef(true)
  useEffect(() => {
    if (arrived.current) {
      arrived.current = false
      return
    }
    api.call<Me>('me').then(
      (m) => {
        who.data.value = m
      },
      // A 401 already led to sign-in (the client does it); offline or an error keeps the screen as it is.
      () => {},
    )
  }, [path])
  const m = who.data.value
  if (!m) {
    if (who.error.value && !isSignedOut(who.error.value)) {
      return (
        <Door>
          <ErrorState error={who.error.value} onRetry={() => void who.reload()} />
        </Door>
      )
    }
    return (
      <Door>
        <Skeleton rows={2} />
      </Door>
    )
  }
  return (
    <Shell me={m} brain={nav}>
      {broken ? (
        <NotFound />
      ) : (
        <Router>
          <Route path="/" component={Home} />
          <Route path="/b/:slug" component={BrainPage} />
          <Route path="/b/:slug/proposals" component={InboxPage} />
          <Route path="/b/:slug/proposals/:id" component={ProposalPage} />
          <Route path="/b/:slug/wiki" component={MapPage} />
          <Route path="/b/:slug/wiki/decisions" component={DecisionsPage} />
          <Route path="/b/:slug/wiki/log" component={LogPage} />
          <Route path="/b/:slug/wiki/graph" component={GraphPage} />
          <Route path="/b/:slug/pages/:address+" component={PagePage} />
          <Route path="/b/:slug/journal" component={SessionsPage} />
          <Route path="/b/:slug/journal/sessions/:id" component={SessionPage} />
          <Route path="/b/:slug/journal/entries/:id" component={EntryPage} />
          <Route path="/b/:slug/journal/conflicts" component={ConflictsPage} />
          <Route path="/b/:slug/journal/forgotten" component={ForgottenPage} />
          <Route path="/b/:slug/journal/to-review" component={ToReviewPage} />
          <Route path="/b/:slug/journal/correct" component={CorrectPage} />
          <Route path="/b/:slug/activity" component={ActivityPage} />
          <Route path="/b/:slug/health" component={HealthPage} />
          <Route path="/people" component={People} />
          <Route default component={NotFound} />
        </Router>
      )}
    </Shell>
  )
}

function Routes() {
  const { path, route } = useLocation()
  const b = branding()
  useScreenTitle(path, installationName(b.data.value))
  useEffect(() => {
    const g = goTo.value
    if (g) {
      goTo.value = null
      route(g.to, g.replace)
    }
  }, [goTo.value])
  const setupRequired = b.data.value?.setupRequired === true
  useEffect(() => {
    if (setupRequired && path !== '/setup') route('/setup', true)
  }, [setupRequired, path])
  if (setupRequired && path !== '/setup') return null
  if (path === '/sign-in') return <SignIn />
  if (path === '/setup') return <Setup />
  if (path === '/invite') return <Invite />
  if (path === '/reset') return <Reset />
  if (DOORS.some((d) => path.startsWith(`${d}/`))) return <NotFoundDoor />
  return <SignedIn />
}

function NotFoundDoor() {
  return (
    <Door>
      <NotFound />
    </Door>
  )
}

export function App() {
  return (
    <LocationProvider>
      <Routes />
    </LocationProvider>
  )
}
