// Follows what happens in a brain (spec B5 «Flujo de eventos», plan §3.3): one EventSource while the
// screen is open and the tab is visible. A hidden tab closes it and, when shown again, resumes from the
// last event id (the server replays up to 24 hours), so counts and first steps change without reloading.
import { useEffect } from 'preact/hooks'
import { invalidate, invalidateByEvent } from '../api/resource.ts'

export function useLive(slug: string | null): void {
  useEffect(() => {
    if (!slug || typeof EventSource === 'undefined') return
    let es: EventSource | null = null
    let last = ''
    const close = () => {
      es?.close()
      es = null
    }
    const open = () => {
      if (es || document.hidden) return
      const at = `/v1/brains/${encodeURIComponent(slug)}/events`
      es = new EventSource(last ? `${at}?lastEventId=${encodeURIComponent(last)}` : at)
      es.onmessage = (m) => {
        if (m.lastEventId) last = m.lastEventId
        try {
          const e = JSON.parse(String(m.data)) as { kind?: unknown }
          if (typeof e.kind === 'string') invalidateByEvent(e.kind, slug)
        } catch {
          // Not an event of Brain: nothing to update.
        }
      }
      // Missed more than the server keeps: the lists catch up.
      es.addEventListener('gap', () => invalidate(`brain:${slug}`))
      // The role changed or the key ended: what the person may see is asked again.
      es.addEventListener('closed', () => {
        close()
        invalidate(`brain:${slug}`)
        invalidate('me')
      })
    }
    const seen = () => (document.hidden ? close() : open())
    open()
    document.addEventListener('visibilitychange', seen)
    return () => {
      document.removeEventListener('visibilitychange', seen)
      close()
    }
  }, [slug])
}
