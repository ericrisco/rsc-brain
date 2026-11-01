// The live module in a screen (plan §3.3): one EventSource while the screen is open, through follow() in
// stream.ts. What an event changes is asked for again, once per burst (a replay of the last 24 hours is one
// burst, not hundreds of reloads); a gap reloads the brain's lists; «closed» asks again what the person may
// see.
import { useEffect, useState } from 'preact/hooks'
import { invalidate, invalidateByEvent } from '../api/resource.ts'
import { follow, type SourceLike, type Stream } from './stream.ts'

export function useStream(slug: string | null): Stream | null {
  const [stream, setStream] = useState<Stream | null>(null)
  useEffect(() => {
    if (!slug || typeof EventSource === 'undefined') return
    const kinds = new Set<string>()
    let flush: ReturnType<typeof setTimeout> | undefined
    const s = follow(
      slug,
      { open: (url) => new EventSource(url) as unknown as SourceLike, doc: document },
      {
        history: true,
        onEvent: (e) => {
          kinds.add(e.kind)
          flush ??= setTimeout(() => {
            flush = undefined
            for (const k of kinds) invalidateByEvent(k, slug)
            kinds.clear()
          }, 300)
        },
        onGap: () => invalidate(`brain:${slug}`),
        onClosed: () => {
          invalidate(`brain:${slug}`)
          invalidate('me')
        },
      },
    )
    setStream(s)
    return () => {
      if (flush !== undefined) clearTimeout(flush)
      s.stop()
      setStream(null)
    }
  }, [slug])
  return stream
}
