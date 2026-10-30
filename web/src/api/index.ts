// The client the screens use: the browser's fetch, and sign-in when a session ends.
import { signal } from '@preact/signals'
import { helpOpen, searchOpen } from '../shell/keys.ts'
import { createClient } from './client.ts'
import { clearDrafts } from './draft.ts'
import { resetResources } from './resource.ts'

// Where the app should go next; the router follows it (an expired session, from anywhere).
export const goTo = signal<{ to: string; replace: boolean } | null>(null)

// Set when a session ended while the web was open, so the sign-in page can say so ("Your session
// ended."); a plain visit to sign-in says nothing.
export const sessionEnded = signal(false)

// What belonged to the session that is over: its data and the dialogs it had open (a search open when
// the session ended must not open again after signing in), and what it typed and did not send.
export function forgetSession(): void {
  resetResources()
  if (typeof sessionStorage !== 'undefined') clearDrafts(sessionStorage)
  searchOpen.value = false
  helpOpen.value = false
}

export const api = createClient({
  transport: (url, init) => fetch(url, init),
  onSignedOut: (to) => {
    // Already on the way to sign-in (another request ended first): keep the address it carries.
    if (location.pathname === '/sign-in') return
    // What the web knew belongs to a session that is over: forgotten before leaving, so the sign-in page
    // asks "who am I" anew and shows its form, instead of sending the person straight back (a loop).
    forgetSession()
    sessionEnded.value = true
    goTo.value = { to, replace: true }
  },
  here: () => location.pathname + location.search,
})
