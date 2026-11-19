// What the look of the web is made of, measured in the page (spec web redesign, «Los valores»): the values a
// screen must compute to, and small readers of computed styles the look checks share.
import type { Page } from '@playwright/test'

// The values of the light mode, as the browser reports them (rgb()).
export const LIGHT = {
  ground: 'rgb(249, 251, 252)',
  surface: 'rgb(255, 255, 255)',
  raised: 'rgb(244, 246, 248)',
  active: 'rgb(235, 237, 238)',
  border: 'rgb(232, 234, 236)',
  rule: 'rgb(240, 241, 242)',
  text: 'rgb(19, 20, 22)',
  muted: 'rgb(93, 95, 96)',
  accent: 'rgb(27, 108, 128)',
  positive: 'rgb(30, 123, 79)',
  negative: 'rgb(196, 36, 42)',
  warning: 'rgb(146, 64, 14)',
  pills: {
    positive: ['rgb(220, 250, 229)', 'rgb(4, 37, 14)'],
    negative: ['rgb(255, 237, 234)', 'rgb(131, 28, 30)'],
    warning: ['rgb(255, 251, 235)', 'rgb(146, 64, 14)'],
    neutral: ['rgb(235, 237, 238)', 'rgb(53, 55, 54)'],
  },
} as const

// The dark mode's starting values (spec, provisional).
export const DARK = {
  ground: 'rgb(15, 16, 17)',
  surface: 'rgb(23, 24, 26)',
  text: 'rgb(242, 243, 244)',
  muted: 'rgb(164, 167, 171)',
  accent: 'rgb(95, 179, 199)',
} as const

export const SANS = /^"?IBM Plex Sans"?(,|$)/
export const MONO = /^"?IBM Plex Mono"?(,|$)/

// What may be written in the monospaced face (spec «La letra»): addresses, ids, keys, commands, code, the
// figures of tables, the keys of the keyboard help and the source text while editing a page.
export const MONO_OK = 'code, pre, kbd, samp, .mono, .num, .address, textarea.source, [data-mono]'

export const parseRgb = (c: string): [number, number, number, number] => {
  const m = /rgba?\(([^)]+)\)/.exec(c)
  if (!m) return [0, 0, 0, 0]
  const p = (m[1] as string)
    .split(/[,\s/]+/)
    .filter(Boolean)
    .map(Number)
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1]
}

export const luminance = (c: string) => {
  const [r, g, b] = parseRgb(c).map((v, i) => {
    if (i > 2) return v
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

// A colour with alpha, laid over an opaque ground: what the eye gets.
export const over = (fg: string, bg: string): string => {
  const [r, g, b, a] = parseRgb(fg)
  if (a >= 1) return fg
  const [br, bgg, bb] = parseRgb(bg)
  const mix = (f: number, k: number) => Math.round(f * a + k * (1 - a))
  return `rgb(${mix(r, br)}, ${mix(g, bgg)}, ${mix(b, bb)})`
}

// The ratio between two colours; a colour with alpha (faded text, a hairline) is first laid over the other, the
// ground, so a faded colour is measured as it is seen.
export const contrast = (a: string, b: string) => {
  const x = luminance(over(a, b))
  const y = luminance(over(b, 'rgb(255, 255, 255)'))
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

// Everything visible on the screen that reads in a face, a case or a colour the look forbids.
export async function offenders(page: Page) {
  return page.evaluate((monoOk) => {
    const out = { mono: [] as string[], upper: [] as string[], violet: [] as string[], big: [] as string[] }
    const small: string[] = []
    const name = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''} «${(el.textContent ?? '').trim().slice(0, 30)}»`
    const rgb = (c: string) => {
      const m = /rgba?\(([^)]+)\)/.exec(c)
      if (!m) return null
      const p = (m[1] as string)
        .split(/[,\s/]+/)
        .filter(Boolean)
        .map(Number)
      if ((p[3] ?? 1) === 0) return null
      return p as [number, number, number]
    }
    // The band of violet and indigo the look forbids: a saturated hue between 250° and 300°.
    const violet = (c: string) => {
      const p = rgb(c)
      if (!p) return false
      const [r, g, b] = p.map((v) => v / 255) as [number, number, number]
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const d = max - min
      const l = (max + min) / 2
      if (d < 0.08) return false
      const s = d / (1 - Math.abs(2 * l - 1))
      let h = 0
      if (max === r) h = ((g - b) / d) % 6
      else if (max === g) h = (b - r) / d + 2
      else h = (r - g) / d + 4
      h = (h * 60 + 360) % 360
      return s > 0.25 && h >= 250 && h <= 300
    }
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || el.closest('.sr-only, [aria-hidden="true"] svg')) continue
      const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim())
      if (ownText) {
        const family = cs.fontFamily.split(',')[0]?.replace(/"/g, '').trim() ?? ''
        if (/mono/i.test(family) && !el.closest(monoOk)) out.mono.push(`${name(el)} in ${family}`)
        if (cs.textTransform === 'uppercase') out.upper.push(name(el))
        const size = Number.parseFloat(cs.fontSize)
        if (/^H[1-6]$/.test(el.tagName) && size > 32) out.big.push(`${name(el)} ${size}px`)
        if (size < 11) small.push(`${name(el)} ${size}px`)
      }
      for (const c of [cs.color, cs.backgroundColor, cs.borderTopColor, cs.outlineColor])
        if (violet(c)) out.violet.push(`${name(el)} ${c}`)
    }
    return { ...out, small }
  }, MONO_OK)
}

// The sheet the screen sits on, and the frame around it.
export async function frame(page: Page) {
  return page.evaluate(() => {
    const box = (sel: string) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return {
        bg: cs.backgroundColor,
        width: r.width,
        height: r.height,
        right: window.innerWidth - r.right,
        bottom: window.innerHeight - r.bottom,
        top: r.top,
        left: r.left,
        border: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
        borderColor: cs.borderTopColor,
        radius: cs.borderTopLeftRadius,
        shadow: cs.boxShadow,
        borderRight: cs.borderRightWidth,
        borderBottom: cs.borderBottomWidth,
        borderLeft: cs.borderLeftWidth,
      }
    }
    return { rail: box('.rail'), top: box('.topbar'), sheet: box('main#main'), stage: box('.stage') }
  })
}
