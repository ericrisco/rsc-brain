// Copies a text to the clipboard and says it did. When it cannot (no clipboard API, as on plain http in a
// local network, or the browser refuses), the text shows in a read-only field, selected, to copy by hand: it is
// never nowhere.
import { useEffect, useId, useRef, useState } from 'preact/hooks'
import { T } from '../text.ts'

// `name`: what a screen reader hears when the visible label alone («Copy») would not say what is copied.
export function CopyButton({
  text,
  label,
  id,
  name,
  onCopy,
}: {
  text: string
  label: string
  id?: string
  name?: string
  // Told when the person asks to copy (whether the clipboard took it or the text shows to copy by hand).
  onCopy?: () => void
}) {
  const [said, setSaid] = useState<string | null>(null)
  const [manual, setManual] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const fieldId = useId()
  const copy = async () => {
    onCopy?.()
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard')
      await navigator.clipboard.writeText(text)
      setManual(false)
      setSaid(T.copy.done)
    } catch {
      setSaid(T.copy.failed)
      setManual(true)
    }
  }
  useEffect(() => {
    if (!manual) return
    field.current?.focus()
    field.current?.select()
  }, [manual, text])
  return (
    <span class="copy">
      <button type="button" class="button" id={id} aria-label={name} onClick={() => void copy()}>
        {label}
      </button>
      <span role="status" class="meta">
        {said}
      </span>
      {manual ? (
        <span class="copy-manual">
          <label for={fieldId} class="meta">
            {T.copy.manual}
          </label>
          <textarea
            id={fieldId}
            ref={field}
            readOnly
            rows={Math.min(8, text.split('\n').length + 1)}
            value={text}
            onFocus={(e) => (e.currentTarget as HTMLTextAreaElement).select()}
          />
        </span>
      ) : null}
    </span>
  )
}
