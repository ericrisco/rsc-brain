// Signing out, from the account menu or from an empty home. A sign-out that did not happen is never
// shown as done: on an error or offline the person stays signed in and is told (C2).
import { useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import type { ApiError } from '../api/client.ts'
import { api, forgetSession } from '../api/index.ts'
import { justSignedOut } from '../session.ts'

export function useSignOut() {
  const [leaving, setLeaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const { route } = useLocation()
  const signOut = async () => {
    if (leaving) return
    setLeaving(true)
    setFailed(false)
    try {
      // Quiet: a session already over is not "a session that ended mid-use" (no "next", no notice).
      await api.call('logout', { body: {}, quiet: true })
    } catch (e) {
      // A session the server no longer knows is signed out already.
      if ((e as ApiError).status !== 401) {
        setLeaving(false)
        setFailed(true)
        return
      }
    }
    forgetSession()
    justSignedOut.value = true
    route('/sign-in', true)
  }
  return { signOut, leaving, failed }
}
