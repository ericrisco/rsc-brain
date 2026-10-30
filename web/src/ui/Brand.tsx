// The name and logo of the installation (spec B6: on every screen). The RSC mark until the
// administration uploads a logo (G3).
import { branding, installationName } from '../session.ts'
import { T } from '../text.ts'
import { Mark } from './Mark.tsx'

// `href` null: the name and logo only, not a link.
export function Brand({ href = '/' }: { href?: string | null }) {
  const b = branding()
  const name = installationName(b.data.value)
  const logo = b.data.value?.logo
  const inside = (
    <>
      {logo ? <img src={logo.url} alt="" /> : <Mark />}
      <span class="name">{name}</span>
    </>
  )
  if (href === null) return <span class="brand">{inside}</span>
  return (
    <a class="brand" href={href}>
      {inside}
      {href === '/' ? <span class="sr-only">, {T.shell.home.toLowerCase()}</span> : null}
    </a>
  )
}
