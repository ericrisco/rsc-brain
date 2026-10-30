// The RSC mark, drawn here (no remote image): three nodes and their links, the first in the accent.
export function Mark({ title }: { title?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : 'true'}
      aria-label={title}
    >
      <circle cx="7" cy="8" r="2.6" fill="var(--accent)" />
      <circle cx="17.5" cy="7" r="2" fill="var(--text)" />
      <circle cx="13" cy="17.5" r="2.6" fill="var(--text)" />
      <path d="M7 8 17.5 7M7 8l6 9.5M17.5 7 13 17.5" stroke="var(--accent)" stroke-width="1.4" fill="none" />
    </svg>
  )
}
