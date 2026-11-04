// A field seeded from what the page knows (useState(value)) follows that value when it changes: a save, Back,
// another person's change read again. Never on the first render: there the field holds it already, and an
// effect runs after paint, so copying it then put back what was typed or picked before it ran (F1-PR13).
import { useEffect, useRef } from 'preact/hooks'

export function useOnChange(key: unknown, then: () => void): void {
  const seen = useRef(key)
  useEffect(() => {
    if (Object.is(seen.current, key)) return
    seen.current = key
    then()
  }, [key])
}
