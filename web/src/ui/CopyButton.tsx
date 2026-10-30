// Copies a text to the clipboard and says it did (or that it could not, so the person selects it).
import { useState } from 'preact/hooks'
import { T } from '../text.ts'

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [said, setSaid] = useState<string | null>(null)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setSaid(T.copy.done)
    } catch {
      setSaid(T.copy.failed)
    }
  }
  return (
    <span class="copy">
      <button type="button" class="button" onClick={() => void copy()}>
        {label}
      </button>
      <span role="status" class="meta">
        {said}
      </span>
    </span>
  )
}
