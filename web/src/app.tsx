// The routes of the web (spec B6 «Mapa de la web»). Before a session: sign in, first run, invitation,
// reset. With one: the shell around home and each brain. Until the first-time setup is done, everything
// leads to it.

import { useEffect } from 'preact/hooks'
import { LocationProvider, Route, Router, useLocation } from 'preact-iso'
import { goTo } from './api/index.ts'
import { signInPath } from './lib/nav.ts'
import { Brain, brainResource } from './screens/Brain.tsx'
import { Home } from './screens/Home.tsx'
import { Invite } from './screens/Invite.tsx'
import { NotFound } from './screens/NotFound.tsx'
import { Reset } from './screens/Reset.tsx'
import { Setup } from './screens/Setup.tsx'
import { SignIn } from './screens/SignIn.tsx'
import { branding, isSignedOut, me } from './session.ts'
import { Door } from './shell/Door.tsx'
import { type BrainNav, Shell } from './shell/Shell.tsx'
import { ErrorState, Skeleton } from './ui/states.tsx'

const DOORS = ['/sign-in', '/setup', '/invite', '/reset']

function brainOf(path: string): string | null {
  const m = /^\/b\/([^/]+)/.exec(path)
  return m?.[1] ? decodeURIComponent(m[1]) : null
}

function BrainPage({ slug }: { slug?: string }) {
  return <Brain slug={slug ?? ''} />
}

function SignedIn() {
  const { path, url, route } = useLocation()
  const who = me()
  const slug = brainOf(path)
  // The brain is asked for only once the person is known (a 401 there would race the one of /v1/me).
  const brain = slug && who.data.value ? brainResource(slug).data.value?.brain : undefined
  const nav: BrainNav | null = brain ? { slug: brain.slug, name: brain.name, role: brain.role } : null
  useEffect(() => {
    if (isSignedOut(who.error.value)) route(signInPath(url), true)
  }, [who.error.value])
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
      <Router>
        <Route path="/" component={Home} />
        <Route path="/b/:slug" component={BrainPage} />
        <Route default component={NotFound} />
      </Router>
    </Shell>
  )
}

function Routes() {
  const { path, route } = useLocation()
  const b = branding()
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
