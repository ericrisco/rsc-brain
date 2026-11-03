// Maintenance as the web knows it (B7 PR35; spec «Actualizar»): while an update or a restore runs, the server refuses
// writes with 503 under_maintenance and keeps serving reads. The web learns it from GET /v1/health (when it starts,
// then now and then) and from any write refused that way, and shows one band on every page until it ends.
import { signal } from '@preact/signals'

// On while the server says it is under maintenance.
export const maintenanceOn = signal(false)

// How often the web looks again: once a minute normally; while it lasts, after what the server said (5 to 30 s).
export const POLL_OFF_MS = 60_000
export function nextLook(on: boolean, retryAfter?: number): number {
  if (!on) return POLL_OFF_MS
  if (retryAfter === undefined) return 10_000
  return Math.min(30_000, Math.max(5_000, retryAfter * 1000))
}

// A refusal because of maintenance.
export const isMaintenance = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'under_maintenance'
