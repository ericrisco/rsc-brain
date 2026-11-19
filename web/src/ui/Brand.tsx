// The name and logo of the installation (spec B6: on every screen). The RSC mark until the
// administration uploads a logo (G3).
import { branding, installationName } from '../session.ts'
import { T } from '../text.ts'
import { Mark } from './Mark.tsx'

// How light the logo is, so its plate can be the other tone and the logo always stands out from it. Read from the
// picture itself, the one the installation serves: its mean luminance over a small copy.
function tone(img: HTMLImageElement) {
  try {
    const c = document.createElement('canvas')
    c.width = c.height = 8
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.drawImage(img, 0, 0, 8, 8)
    const d = ctx.getImageData(0, 0, 8, 8).data
    let sum = 0
    let seen = 0
    for (let i = 0; i < d.length; i += 4) {
      const a = (d[i + 3] as number) / 255
      if (a < 0.1) continue
      seen += 1
      sum += (0.2126 * (d[i] as number) + 0.7152 * (d[i + 1] as number) + 0.0722 * (d[i + 2] as number)) / 255
    }
    img.dataset.tone = seen && sum / seen > 0.6 ? 'light' : 'dark'
  } catch {
    // A picture that cannot be read keeps the light plate.
  }
}

// `href` null: the name and logo only, not a link.
export function Brand({ href = '/' }: { href?: string | null }) {
  const b = branding()
  const name = installationName(b.data.value)
  const logo = b.data.value?.logo
  const inside = (
    <>
      {logo ? <img src={logo.url} alt="" onLoad={(e) => tone(e.currentTarget)} /> : <Mark />}
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
