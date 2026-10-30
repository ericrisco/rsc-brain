// The states every screen has (spec B6 «Estados en todas las pantallas»), decided from what the screen
// holds. Content already on screen is never replaced by a spinner or an error: a failed refresh keeps it.
import type { ApiError } from '../api/client.ts'
import { T } from '../text.ts'

export type ViewState = 'loading' | 'ready' | 'empty' | 'filtered-empty' | 'error' | 'offline' | 'forbidden'

export function viewState<D>(s: {
  loading: boolean
  data: D | undefined
  error?: ApiError | undefined
  online: boolean
  isEmpty?: (d: D) => boolean
  filtered?: boolean
}): ViewState {
  if (s.data !== undefined) {
    if (s.isEmpty?.(s.data)) return s.filtered ? 'filtered-empty' : 'empty'
    return 'ready'
  }
  if (s.error) return errorView(s.error, s.online).kind
  return 'loading'
}

export type ErrorView = {
  kind: 'error' | 'offline' | 'forbidden'
  title: string
  message: string
  howToProceed: string
  retry: boolean
}

// 403 and 404 read the same on purpose: a brain you cannot read answers like one that does not exist
// (constitution Brain P4); the server's own words say who to ask.
export function errorView(e: ApiError, online = true): ErrorView {
  if (e.code === 'offline' || !online)
    return {
      kind: 'offline',
      title: T.states.offlineTitle,
      message: e.message,
      howToProceed: e.howToProceed,
      retry: true,
    }
  if (e.status === 403 || e.status === 404)
    return {
      kind: 'forbidden',
      title: T.states.forbiddenTitle,
      message: e.message,
      howToProceed: e.howToProceed,
      retry: false,
    }
  return {
    kind: 'error',
    title: T.states.errorTitle,
    message: e.message,
    howToProceed: e.howToProceed,
    retry: true,
  }
}

// Why a write cannot be sent right now, or null when it can (spec B6: «las acciones de escritura se
// desactivan con el motivo»; «no se puede pulsar dos veces»).
export function writeBlocked(s: { online: boolean; pending: boolean }): string | null {
  if (!s.online) return T.states.writeOffline
  if (s.pending) return T.states.writePending
  return null
}
