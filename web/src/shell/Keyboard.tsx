// Listens for the shortcuts of lib/shortcuts.ts and does what their visible controls do.

import { useLayoutEffect, useRef } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import { createKeymap } from '../lib/shortcuts.ts'
import { helpOpen, isTyping, searchOpen } from './keys.ts'

export function Keyboard({
  signedIn,
  brain,
  canInvite = false,
}: {
  signedIn: boolean
  brain: string | null
  canInvite?: boolean
}) {
  const { route } = useLocation()
  // Read when a key is pressed, not when the listener was set: the brain arrives with its data, and a
  // shortcut pressed the moment its side bar shows must already know it.
  const now = useRef({ signedIn, brain, route, canInvite })
  now.current = { signedIn, brain, route, canInvite }
  // Before the paint, not after: once the shell shows, its shortcuts already listen.
  useLayoutEffect(() => {
    const map = createKeymap(() => Date.now())
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return
      // Inside an open dialog only the dialog's own keys work (Esc closes it).
      if (document.querySelector('dialog[open]') && e.key !== 'Escape') {
        const id = map.handle({
          key: e.key,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          typing: true,
        })
        if (id !== 'search') return
      }
      const id = map.handle({
        key: e.key,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        typing: isTyping(e.target),
      })
      if (!id) return
      const { signedIn, brain, route, canInvite } = now.current
      if (id === 'help') {
        e.preventDefault()
        helpOpen.value = true
      } else if (id === 'search' && signedIn) {
        e.preventDefault()
        helpOpen.value = false
        searchOpen.value = true
      } else if (id === 'go-home' && signedIn) {
        route('/')
      } else if (id === 'go-people' && signedIn && canInvite) {
        route('/people')
      } else if (id === 'go-overview' && signedIn && brain) {
        route(`/b/${encodeURIComponent(brain)}`)
      } else if (id === 'go-wiki' && signedIn && brain) {
        route(`/b/${encodeURIComponent(brain)}/wiki`)
      } else if (id === 'go-decisions' && signedIn && brain) {
        route(`/b/${encodeURIComponent(brain)}/wiki/decisions`)
      } else if (id === 'go-log' && signedIn && brain) {
        route(`/b/${encodeURIComponent(brain)}/wiki/log`)
      } else if (id === 'go-journal' && signedIn && brain) {
        route(`/b/${encodeURIComponent(brain)}/journal`)
      } else if (id === 'edit' && signedIn) {
        // What "Edit" above a page does; on a page that has no Edit (not a curator), nothing.
        const edit = document.querySelector<HTMLAnchorElement>('main a[data-view="edit"]')
        if (edit) {
          e.preventDefault()
          route(edit.getAttribute('href') ?? '')
        }
      }
    }
    window.addEventListener('keydown', onKey)
    document.documentElement.dataset.keys = 'on'
    return () => {
      window.removeEventListener('keydown', onKey)
      delete document.documentElement.dataset.keys
    }
  }, [])
  return null
}
