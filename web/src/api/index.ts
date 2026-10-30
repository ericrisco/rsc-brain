// The client the screens use: the browser's fetch, and sign-in when a session ends.
import { signal } from '@preact/signals'
import { createClient } from './client.ts'

// Where the app should go next; the router follows it (an expired session, from anywhere).
export const goTo = signal<{ to: string; replace: boolean } | null>(null)

export const api = createClient({
  transport: (url, init) => fetch(url, init),
  onSignedOut: (to) => {
    // Already on the way to sign-in (another request ended first): keep the address it carries.
    if (location.pathname === '/sign-in') return
    goTo.value = { to, replace: true }
  },
  here: () => location.pathname + location.search,
})
