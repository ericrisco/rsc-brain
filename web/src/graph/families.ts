// The page types' families (spec amendment 2026-11-09, CA12; plan canvas-ui SB3): each type in a colour of
// its own among the seven of shared.css v2, used where pages are listed by type (the wiki's map). The graph
// colours by community instead (communities.ts, v0.5.0). No DOM here.
import { PAGE_TYPES } from '../lib/wiki.ts'

export type FamilyColour = 'orange' | 'amber' | 'blue' | 'cyan' | 'pink' | 'violet' | 'green'
export type Family = { type: string; colour: FamilyColour }

const COLOUR: Record<(typeof PAGE_TYPES)[number], FamilyColour> = {
  topic: 'orange',
  entity: 'blue',
  guide: 'cyan',
  overview: 'amber',
  agent: 'violet',
  decision: 'pink',
  source: 'green',
}

// In the order of PAGE_TYPES (the same order as the shapes): the index of a family is the index of its type.
export const FAMILIES: readonly Family[] = PAGE_TYPES.map((type) => ({ type, colour: COLOUR[type] }))

const byType = new Map(FAMILIES.map((f, k) => [f.type, k]))
const indexOfType = (type: string) => byType.get(type) ?? 0

// An unknown type is drawn in the first family: never out of the picture.
export const familyOfType = (type: string): Family => FAMILIES[indexOfType(type)] as Family
