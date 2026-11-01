// The dialogs any screen can open: creating a brain. A shared signal, so a card, a first step and the
// top bar open the same one. Connecting an agent is a page of its own (/connect).
import { signal } from '@preact/signals'

// «Connect your agent», for the installation or naming a brain.
export const connectHref = (brain: string | null) =>
  brain ? `/connect?brain=${encodeURIComponent(brain)}` : '/connect'
export const createOpen = signal(false)
