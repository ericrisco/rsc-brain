// The shared tokens (the same file in rsc-brain and rsc-factory, byte for byte) and Brain's own over them
// (spec web redesign, «Los valores», «Los tres modos»; CA26, CA27, CA33). The light mode holds the values of
// the table; dark and high contrast hold their own; every ink meant to be read passes 4.5:1 in light and dark
// and 7:1 in high contrast, every edge that is all a control shows reaches 3:1 (4.5:1 in high contrast). The
// faces are self-hosted with their licence. With no choice the sheet follows the system.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const STYLES = new URL('../../web/src/styles/', import.meta.url)
const shared = readFileSync(new URL('shared.css', STYLES), 'utf8')
const tokens = readFileSync(new URL('tokens.css', STYLES), 'utf8')

type Block = { selector: string; media: string | null; vars: Map<string, string> }

function blocks(css: string): Block[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Block[] = []
  const read = (body: string, media: string | null) => {
    const re = /([^{}]+)\{([^{}]*)\}/g
    for (let m = re.exec(body); m; m = re.exec(body)) {
      const vars = new Map<string, string>()
      for (const d of (m[2] ?? '').split(';')) {
        const i = d.indexOf(':')
        const name = d.slice(0, i).trim()
        if (name.startsWith('--')) vars.set(name, d.slice(i + 1).trim())
      }
      out.push({ selector: (m[1] ?? '').trim().replace(/\s+/g, ' '), media, vars })
    }
  }
  let rest = text
  const media = /@media([^{]+)\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g
  for (let m = media.exec(text); m; m = media.exec(text)) {
    read(m[2] ?? '', (m[1] ?? '').trim())
    rest = rest.replace(m[0], '')
  }
  read(rest, null)
  return out
}

type Mode = 'light' | 'dark' | 'contrast'
// What a mode chosen by the person sees: :root, then its own block.
function chosen(sheet: Block[], mode: Mode) {
  const vars = new Map<string, string>()
  const take = (b: Block) => {
    for (const [k, v] of b.vars) vars.set(k, v)
  }
  const sel = (b: Block) => b.selector.split(',').map((s) => s.trim())
  for (const b of sheet) if (!b.media && sel(b).includes(':root')) take(b)
  for (const b of sheet) if (!b.media && sel(b).includes(`:root[data-theme="${mode}"]`)) take(b)
  return vars
}
// What the system's preference gives with no choice (no data-theme): :root, then its media block.
function system(sheet: Block[], query: string) {
  const vars = new Map<string, string>()
  for (const b of sheet) if (!b.media && b.selector === ':root') for (const [k, v] of b.vars) vars.set(k, v)
  for (const b of sheet)
    if (b.media?.includes(query) && b.selector === ':root:not([data-theme])')
      for (const [k, v] of b.vars) vars.set(k, v)
  return vars
}

const hex = (v: string) => {
  const m = /^#([0-9a-f]{6})$/i.exec(v.trim())
  assert.ok(m, `${v} is a #rrggbb colour`)
  const n = Number.parseInt(m[1] as string, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const
}
const lum = (v: string) => {
  const [r, g, b] = hex(v).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function resolve(vars: Map<string, string>, value: string, depth = 0): string {
  const m = /^var\((--[\w-]+)\)$/.exec(value)
  if (!m || depth > 8) return value
  const next = vars.get(m[1] as string)
  assert.ok(next, `${m[1]} is defined`)
  return resolve(vars, next, depth + 1)
}
const contrast = (vars: Map<string, string>, a: string, b: string) => {
  const x = lum(resolve(vars, vars.get(a) ?? `missing ${a}`))
  const y = lum(resolve(vars, vars.get(b) ?? `missing ${b}`))
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

// The table of «Los valores» of the spec: the light mode.
export const VALUES: Record<string, string> = {
  '--ground': '#f9fbfc',
  '--surface': '#ffffff',
  '--raised': '#f4f6f8',
  '--active': '#ebedee',
  '--border': '#e8eaec',
  '--rule': '#f0f1f2',
  '--control': '#cdced1',
  '--text': '#131416',
  '--muted': '#5d5f60',
  '--accent': '#1b6c80',
  '--positive': '#1e7b4f',
  '--negative': '#c4242a',
  '--warning': '#92400e',
  '--pill-positive-bg': '#dcfae5',
  '--pill-positive-ink': '#04250e',
  '--pill-negative-bg': '#ffedea',
  '--pill-negative-ink': '#831c1e',
  '--pill-warning-bg': '#fffbeb',
  '--pill-warning-ink': '#92400e',
  '--pill-neutral-bg': '#ebedee',
  '--pill-neutral-ink': '#353736',
  '--radius-card': '8px',
  '--radius-control': '6px',
  '--radius-sheet': '16px',
  '--row-height': '48px',
  '--control-height': '32px',
  '--gap': '24px',
  '--pad': '24px',
  '--sidebar-width': '228px',
  '--topbar-height': '48px',
  '--sheet-inset': '8px',
  '--fs-title': '22px',
  '--fs-section': '16px',
  '--fs-kpi': '28px',
  '--fs-body': '14px',
  '--fs-small': '12px',
}
// The dark mode's starting values (spec, provisional).
export const DARK: Record<string, string> = {
  '--ground': '#0f1011',
  '--surface': '#17181a',
  '--raised': '#1e2022',
  '--active': '#26282b',
  '--border': '#2a2c2f',
  '--rule': '#202224',
  '--control': '#6b6f75',
  '--text': '#f2f3f4',
  '--muted': '#a4a7ab',
  '--accent': '#5fb3c7',
  '--positive': '#4cc38a',
  '--negative': '#f0787c',
  '--warning': '#e0a85a',
}

const sharedBlocks = blocks(shared)
const brain = [...sharedBlocks, ...blocks(tokens)]
const MODES: Mode[] = ['light', 'dark', 'contrast']

describe('shared tokens (shared.css)', () => {
  it('says which version it is, so the copies in both repos can be compared', () => {
    assert.match(shared, /^\/\* shared\.css v\d+ /)
  })

  it('is the same file as rsc-factory’s, byte for byte, with the same faces (CA26)', {
    skip: process.env.FACTORY_SHARED_DIR
      ? false
      : 'set FACTORY_SHARED_DIR to the folder holding rsc-factory’s shared.css and fonts/ to compare',
  }, () => {
    const dir = process.env.FACTORY_SHARED_DIR as string
    assert.equal(readFileSync(`${dir}/shared.css`, 'utf8'), shared)
    const theirs = readdirSync(`${dir}/fonts`).sort()
    const ours = readdirSync(new URL('fonts/', STYLES)).sort()
    assert.deepEqual(ours, theirs)
    for (const f of ours)
      assert.ok(readFileSync(`${dir}/fonts/${f}`).equals(readFileSync(new URL(`fonts/${f}`, STYLES))), f)
  })

  it('holds the values of the spec in light (CA27, CA33)', () => {
    const vars = chosen(sharedBlocks, 'light')
    for (const [k, v] of Object.entries(VALUES)) assert.equal(vars.get(k)?.toLowerCase(), v, k)
    // With no choice and nothing asked, it is the same.
    const first = system(sharedBlocks, 'nothing')
    for (const [k, v] of Object.entries(VALUES)) assert.equal(first.get(k)?.toLowerCase(), v, k)
  })

  it('holds the starting values of dark, chosen or asked by the system', () => {
    for (const vars of [chosen(sharedBlocks, 'dark'), system(sharedBlocks, 'prefers-color-scheme: dark')])
      for (const [k, v] of Object.entries(DARK)) assert.equal(vars.get(k)?.toLowerCase(), v, k)
  })

  it('high contrast: chosen or asked by the system, white ground and black text, a 3px focus', () => {
    for (const vars of [chosen(sharedBlocks, 'contrast'), system(sharedBlocks, 'prefers-contrast: more')]) {
      assert.equal(vars.get('--surface'), '#ffffff')
      assert.equal(vars.get('--text'), '#000000')
      assert.equal(vars.get('--focus-w'), '3px')
    }
  })

  it('the layout, sizes and type are the same in the three modes (CA10b)', () => {
    const SIZES = Object.keys(VALUES).filter((k) =>
      /^--(radius|row|control-height|gap|pad|sidebar|topbar|sheet|fs-)/.test(k),
    )
    const light = chosen(sharedBlocks, 'light')
    for (const mode of ['dark', 'contrast'] as const) {
      const vars = chosen(sharedBlocks, mode)
      for (const k of [...SIZES, '--font-sans', '--font-mono'])
        assert.equal(vars.get(k), light.get(k), `${k} in ${mode}`)
    }
  })

  it('the faces are IBM Plex, self-hosted, with their licence', () => {
    const faces = [...shared.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1] ?? '')
    assert.ok(faces.length >= 4)
    for (const f of faces) {
      assert.match(f, /font-family:\s*"IBM Plex (Sans|Mono)"/)
      assert.match(f, /font-display:\s*swap/)
      assert.match(f, /src:\s*url\("\.\/fonts\/[\w.-]+\.woff2"\)\s*format\("woff2"\)/)
      const file = /url\("\.\/fonts\/([\w.-]+)"\)/.exec(f)?.[1] as string
      assert.ok(existsSync(new URL(`fonts/${file}`, STYLES)), `${file} is there`)
    }
    assert.match(readFileSync(new URL('fonts/OFL.txt', STYLES), 'utf8'), /SIL OPEN FONT LICENSE/i)
    assert.match(chosen(sharedBlocks, 'light').get('--font-sans') ?? '', /^"IBM Plex Sans"/)
    assert.match(chosen(sharedBlocks, 'light').get('--font-mono') ?? '', /^"IBM Plex Mono"/)
  })

  it('reduced motion turns the durations to zero', () => {
    const reduced = sharedBlocks.filter((b) => b.media?.includes('prefers-reduced-motion: reduce'))
    const vars = new Map(reduced.flatMap((b) => [...b.vars]))
    assert.equal(vars.get('--t-fast'), '0ms')
    assert.equal(vars.get('--t'), '0ms')
  })
})

describe("Brain's tokens over the shared ones (tokens.css)", () => {
  it('give the screens their names as aliases of the shared ones', () => {
    const vars = chosen(brain, 'light')
    assert.equal(vars.get('--sans'), 'var(--font-sans)')
    assert.equal(vars.get('--mono'), 'var(--font-mono)')
    assert.equal(vars.get('--danger'), 'var(--negative)')
    assert.equal(vars.get('--primary-bg'), 'var(--primary)')
    assert.equal(vars.get('--rail-w-open'), 'var(--sidebar-width)')
    assert.equal(vars.get('--field-line'), 'var(--control-strong)')
  })

  for (const mode of MODES) {
    const floor = mode === 'contrast' ? 7 : 4.5
    it(`the words read at ${floor}:1 on their grounds, in ${mode}`, () => {
      const vars = chosen(brain, mode)
      for (const [ink, ground] of [
        ['--text', '--ground'],
        ['--text', '--surface'],
        ['--text', '--raised'],
        ['--text', '--active'],
        ['--muted', '--ground'],
        ['--muted', '--surface'],
        ['--muted', '--raised'],
        ['--accent', '--surface'],
        ['--negative', '--surface'],
        ['--warning', '--surface'],
        ['--positive', '--surface'],
        ['--primary-ink', '--primary'],
        ['--pill-positive-ink', '--pill-positive-bg'],
        ['--pill-negative-ink', '--pill-negative-bg'],
        ['--pill-warning-ink', '--pill-warning-bg'],
        ['--pill-neutral-ink', '--pill-neutral-bg'],
      ] as const) {
        const c = contrast(vars, ink, ground)
        assert.ok(c >= floor, `${ink} on ${ground} in ${mode}: ${c.toFixed(2)}:1`)
      }
    })

    it(`an edge that is all a control shows reaches ${mode === 'contrast' ? '4.5' : '3'}:1, in ${mode}`, () => {
      const vars = chosen(brain, mode)
      const c = contrast(vars, '--control-strong', '--surface')
      assert.ok(
        c >= (mode === 'contrast' ? 4.5 : 3),
        `--control-strong on --surface in ${mode}: ${c.toFixed(2)}:1`,
      )
    })

    it(`the graph's pages and what is picked stand out from its well, in ${mode}`, () => {
      const vars = chosen(brain, mode)
      for (const n of ['--graph-node', '--accent']) {
        const c = contrast(vars, n, '--raised')
        assert.ok(c >= 3, `${n} on --raised in ${mode}: ${c.toFixed(2)}:1`)
      }
    })
  }

  it('dark: the sheet is a step lighter than the frame, and no ground is tinted blue (CA10c)', () => {
    const vars = chosen(brain, 'dark')
    assert.ok(lum(vars.get('--surface') as string) > lum(vars.get('--ground') as string))
    for (const k of ['--ground', '--surface', '--raised', '--active', '--border']) {
      const [r, , b] = hex(vars.get(k) as string)
      assert.ok(b - r <= 6, `${k} has a blue tint`)
    }
  })

  it('the pick in the graph has a thicker ring in high contrast', () => {
    assert.equal(chosen(brain, 'light').get('--graph-ring'), '2.5')
    assert.equal(chosen(brain, 'contrast').get('--graph-ring'), '4')
  })
})
