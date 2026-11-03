// The band of every page while rsc-brain is under maintenance (B7 PR35; spec «Actualizar»): an update or a restore
// refuses writes and keeps serving reads. The web asks GET /v1/health when it starts and once a minute; a write refused
// with 503 under_maintenance turns the band on at once; while it lasts the web looks again every few seconds, and the
// band goes when the server takes writes again.
import { useEffect } from 'preact/hooks'
import { api } from '../api/index.ts'
import { maintenanceOn, nextLook } from '../lib/maintenance.ts'
import { T } from '../text.ts'

export function MaintenanceStrip() {
  const on = maintenanceOn.value
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const look = async () => {
      try {
        const h = await api.call<{ maintenance?: boolean }>('health', { quiet: true })
        if (!stopped) maintenanceOn.value = h.maintenance === true
      } catch {
        // Not reachable now: the offline strip or the screen says so; the band stays as it was.
      }
      if (!stopped) timer = setTimeout(() => void look(), nextLook(maintenanceOn.value))
    }
    // On a change (a refused write turned it on): look again after a while, not at once.
    timer = setTimeout(() => void look(), on ? nextLook(true) : 0)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [on])
  if (!on) return null
  return (
    <div class="offline-strip maintenance-strip" role="status" data-state="maintenance">
      <strong>{T.kind.maintenance}</strong>
      <span>{T.shell.maintenance}</span>
    </div>
  )
}
