import { signal } from '@preact/signals'

export type Locale = 'en' | 'es'

const STORAGE_KEY = 'rscb.locale'

function storedLocale(): Locale | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved === 'en' || saved === 'es' ? saved : null
  } catch {
    return null
  }
}

function browserLocale(): Locale {
  const languages = typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language]
  return languages.some((language) => language.toLowerCase().startsWith('es')) ? 'es' : 'en'
}

export const locale = signal<Locale>(storedLocale() ?? browserLocale())

export function formatNumber(value: number): string {
  return value.toLocaleString(locale.value === 'es' ? 'es-ES' : 'en-US', {
    useGrouping: locale.value === 'es' ? 'always' : 'auto',
  })
}

function syncDocumentLanguage(value: Locale): void {
  const doc = (globalThis as { document?: { documentElement: { lang: string } } }).document
  if (doc) doc.documentElement.lang = value
}

syncDocumentLanguage(locale.value)

export function setLocale(value: Locale): void {
  locale.value = value
  syncDocumentLanguage(value)
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    // The language remains usable for this visit when storage is unavailable.
  }
}
