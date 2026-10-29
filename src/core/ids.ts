// Identifiers: a short prefix that says what it is, then 12 random hex characters.
import { randomBytes } from 'node:crypto'

export type IdPrefix = 'acc' | 'brn' | 'crd' | 'ses' | 'ent' | 'rel' | 'pg' | 'prp' | 'wlg'

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`
}
