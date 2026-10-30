// The dialogs any screen can open: connecting an agent (for a brain, or for the installation) and
// creating a brain. Shared signals, so a card, a first step and the top bar open the same one.
import { signal } from '@preact/signals'

// null: closed; { brain: null }: the installation; { brain: slug }: the kit names that brain.
export const connectFor = signal<{ brain: string | null } | null>(null)
export const createOpen = signal(false)
