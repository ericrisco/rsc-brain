// The client the screens use: the browser's fetch, and sign-in when a session ends.
import { signal } from '@preact/signals'
import { createClient } from './client.ts'
import { resetResources } from './resource.ts'

// Where the app should go next; the router follows it (an expired session, from anywhere).
export const goTo = signal<{ to: string; replace: boolean } | null>(null)

export const api = createClient({
  transport: (url, init) => fetch(url, init),
  onSignedOut: (to) => {
    // Already on the way to sign-in (another request ended first): keep the address it carries.
    if (location.pathname === '/sign-in') return
    // What the web knew belongs to a session that is over: forgotten before leaving, so the sign-in page
    // asks "who am I" anew and shows its form, instead of sending the person straight back (a loop).
    resetResources()
    goTo.value = { to, replace: true }
  },
  here: () => location.pathname + location.search,
})
