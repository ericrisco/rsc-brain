import { locale, setLocale } from '../locale.ts'
import { T } from '../text.ts'

export function LanguagePicker({ variant }: { variant: 'menu' | 'door' }) {
  return (
    <fieldset class={`language-picker language-picker--${variant}`}>
      <legend class={variant === 'door' ? 'sr-only' : 'language-picker-title'}>{T.shell.language}</legend>
      <div class="language-picker-options">
        <button type="button" aria-pressed={locale.value === 'en'} onClick={() => setLocale('en')}>
          {T.shell.english}
        </button>
        <button type="button" aria-pressed={locale.value === 'es'} onClick={() => setLocale('es')}>
          {T.shell.spanish}
        </button>
      </div>
    </fieldset>
  )
}
