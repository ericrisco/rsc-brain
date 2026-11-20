import { locale, setLocale } from '../locale.ts'
import { T } from '../text.ts'

export function LanguagePicker({ variant }: { variant: 'menu' | 'door' }) {
  return (
    <div class={`language-picker language-picker--${variant}`} role="group" aria-label={T.shell.language}>
      <span class={variant === 'door' ? 'sr-only' : 'language-picker-title'}>{T.shell.language}</span>
      <div class="language-picker-options">
        <button type="button" aria-pressed={locale.value === 'en'} onClick={() => setLocale('en')}>
          {T.shell.english}
        </button>
        <button type="button" aria-pressed={locale.value === 'es'} onClick={() => setLocale('es')}>
          {T.shell.spanish}
        </button>
      </div>
    </div>
  )
}
