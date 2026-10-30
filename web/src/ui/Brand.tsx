// The name and logo of the installation (spec B6: on every screen). The RSC mark until the
// administration uploads a logo (G3).
import { branding, installationName } from '../session.ts'
import { T } from '../text.ts'
import { Mark } from './Mark.tsx'

export function Brand({ href = '/' }: { href?: string }) {
  const b = branding()
  const name = installationName(b.data.value)
  const logo = b.data.value?.logo
  return (
    <a class="brand" href={href}>
      {logo ? <img src={logo.url} alt="" /> : <Mark />}
      <span class="name">{name}</span>
      {href === '/' ? <span class="sr-only">, {T.shell.home.toLowerCase()}</span> : null}
    </a>
  )
}
