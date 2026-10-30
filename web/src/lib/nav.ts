// Where the web may send a person after signing in: only an address inside the web. Anything that could
// leave the origin ("//host", "https:", "/\host") or loop back to sign-in goes home instead.
export function safeNext(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return '/'
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/'
  // Control characters and spaces have no place in an address the web made itself.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point of this check
  if (/[\u0000- \u007f\\]/.test(raw)) return '/'
  if (raw === '/sign-in' || raw.startsWith('/sign-in?') || raw.startsWith('/sign-in/')) return '/'
  return raw
}

export function signInPath(next: string): string {
  const safe = safeNext(next)
  return safe === '/' ? '/sign-in' : `/sign-in?next=${encodeURIComponent(safe)}`
}

// The token of an invitation or reset link travels after "#token=" (never sent to the server in the
// address, never in its logs).
export function tokenFromHash(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const t = params.get('token')
  return t && /^[A-Za-z0-9_-]{8,200}$/.test(t) ? t : null
}
