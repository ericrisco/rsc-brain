// What every screen knows: the installation (name, logo, setup pending), who is signed in, and whether
// the browser is online.
import { signal } from '@preact/signals'
import type { ApiError } from './api/client.ts'
import { api } from './api/index.ts'
import { resource } from './api/resource.ts'

export type Branding = {
  name: string
  logo: { url: string; updatedAt: string } | null
  setupRequired: boolean
  // The installation can send email (reset links, invitations).
  canSendMail: boolean
}
export type Me = {
  account: { id: string; kind: string; name: string; email: string | null; isAdmin: boolean }
  key: { id: string; kind: string; perm: string }
}

export const branding = () => resource<Branding>('branding', () => api.call<Branding>('branding'))
// Asked quietly: on the sign-in page a 401 is the expected answer, not a reason to move.
export const me = () => resource<Me>('me', () => api.call<Me>('me', { quiet: true }))

// Set by the first-time setup when it worked, so home can confirm it ("Brain is set up.").
export const justSetUp = signal(false)

// Set by "Sign out" when it worked, so the sign-in page can confirm it ("Signed out.").
export const justSignedOut = signal(false)

export const online = signal(typeof navigator === 'undefined' ? true : navigator.onLine)
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    online.value = true
  })
  window.addEventListener('offline', () => {
    online.value = false
  })
}

export const isSignedOut = (e: ApiError | undefined) => e?.status === 401

export function installationName(b: Branding | undefined): string {
  return b?.name?.trim() || 'Brain'
}
