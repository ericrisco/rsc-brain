// What every screen knows: the installation (name, logo, setup pending), who is signed in, and whether
// the browser is online.
import { signal } from '@preact/signals'
import type { ApiError } from './api/client.ts'
import { api } from './api/index.ts'
import { resource } from './api/resource.ts'
import { T } from './text.ts'

export type Branding = {
  name: string
  logo: { url: string; updatedAt: string } | null
  setupRequired: boolean
  // The installation can send email (reset links, invitations).
  canSendMail: boolean
}
export type Me = {
  account: {
    id: string
    kind: string
    name: string
    email: string | null
    isAdmin: boolean
    // What this session may do (GET /v1/me, G5): the web offers only what the server allows.
    canCreateBrains: boolean
    canInvite: boolean
    // Only a web session learns it; null for any other key.
    totp: boolean | null
  }
  key: { id: string; kind: string; perm: string }
  installation: { name: string; factoryUrl: string | null }
}

export const branding = () => resource<Branding>('branding', () => api.call<Branding>('branding'))
// Asked quietly: on the sign-in page a 401 is the expected answer, not a reason to move.
export const me = () => resource<Me>('me', () => api.call<Me>('me', { quiet: true }))

// Set by the first-time setup when it worked, so home can confirm it ("Brain is set up.").
export const justSetUp = signal(false)

// Set by accepting an invitation, so home can welcome the person with what they joined.
export type Joined = Array<{ slug: string; name: string; role: string }>
export const justJoined = signal<Joined | null>(null)

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
  return b?.name?.trim() || T.brandFallback
}
