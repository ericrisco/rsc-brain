// Which field of a form a refusal is about, from the server's own words, so the keyboard can go there.
export function fieldOf(message: string): string | null {
  if (/password/i.test(message)) return 'password'
  if (/publicUrl|address/i.test(message)) return 'publicUrl'
  if (/installation needs a name/i.test(message)) return 'name'
  if (/your name/i.test(message)) return 'name'
  if (/email/i.test(message)) return 'email'
  return null
}

// Puts the keyboard on that field; true when it did (the alert then need not take focus).
export function focusFieldOf(message: string): boolean {
  const name = fieldOf(message)
  const el = name ? document.querySelector<HTMLInputElement>(`form input[name="${name}"]`) : null
  if (!el) return false
  el.focus()
  el.select()
  return true
}
