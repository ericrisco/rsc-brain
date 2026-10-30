// Follows what happens in a brain (spec B5 «Flujo de eventos», plan §3.3): one EventSource while the
// screen is open and the tab is visible. It starts from the cursor of the overview on screen (the id of
// the newest event that overview already shows), so nothing between the overview and the stream is
// missed. A hidden tab closes it; shown again, the overview is asked again and the stream resumes from
// the newest id it knows (the server replays up to 24 hours), so counts and first steps change without
// reloading, even when the tab was hidden before the first event.
import { useEffect, useRef } from 'preact/hooks'
import { invalidate, invalidateByEvent } from '../api/resource.ts'

const newer = (a: string, b: string) => (Number(b) > Number(a) ? b : a)

// `looks`: a search or a read in the brain matters to the screen too (the first step «Connect your
// agent» waits for any call of an agent, a read included); otherwise only changes do.
export function useLive(slug: string | null, cursor?: string, looks = false): void {
  // The newest cursor of the overview, read when the stream (re)opens.
  const latest = useRef(cursor ?? '')
  if (cursor) latest.current = newer(latest.current, cursor)
  const looking = useRef(looks)
  looking.current = looks
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
      const from = newer(last, latest.current)
      const at = `/v1/brains/${encodeURIComponent(slug)}/events`
      es = new EventSource(from ? `${at}?lastEventId=${encodeURIComponent(from)}` : at)
      es.onmessage = (m) => {
        if (m.lastEventId) last = newer(last, m.lastEventId)
        try {
          const e = JSON.parse(String(m.data)) as { kind?: unknown }
          if (typeof e.kind !== 'string') return
          if (looking.current && (e.kind === 'search' || e.kind === 'read'))
            invalidate(`brain:${slug}:overview`)
          else invalidateByEvent(e.kind, slug)
        } catch {
          // Not an event of rsc-brain: nothing to update.
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
    const seen = () => {
      if (document.hidden) return close()
      // Back from a hidden tab: the overview catches up too, whatever the stream replays.
      invalidate(`brain:${slug}:overview`)
      open()
    }
    open()
    document.addEventListener('visibilitychange', seen)
    return () => {
      document.removeEventListener('visibilitychange', seen)
      close()
    }
  }, [slug])
}
