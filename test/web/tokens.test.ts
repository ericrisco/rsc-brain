// Plan canvas-ui §0 and B1: the shared tokens (shared.css, the same file in rsc-brain and rsc-factory) hold
// the contract's names in both themes, Brain's own tokens keep the old names as aliases of the new ones,
// and every pair of ink and ground meant to be read passes 4.5:1 (WCAG 2.2 AA) in light and in dark.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const STYLES = new URL('../../web/src/styles/', import.meta.url)
const shared = readFileSync(new URL('shared.css', STYLES), 'utf8')
const tokens = readFileSync(new URL('tokens.css', STYLES), 'utf8')

type Block = { selector: string; media: string | null; vars: Map<string, string> }

// The rule blocks of a sheet with their custom properties, and the @media each sits in (one level deep).
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

const DARK_QUERY = '(prefers-color-scheme: dark)'
// What a theme sees: the light values on :root, then, in dark, the dark ones over them. `how` is the way
// dark arrives: the system's preference (rsc-factory) or the attribute the person's choice sets (rsc-brain).
function theme(sheet: Block[], t: 'light' | 'dark', how: 'system' | 'attribute' = 'attribute') {
  const vars = new Map<string, string>()
  const take = (b: Block) => {
    for (const [k, v] of b.vars) vars.set(k, v)
  }
  const sel = (b: Block) => b.selector.split(',').map((s) => s.trim())
  for (const b of sheet) if (!b.media && sel(b).includes(':root')) take(b)
  if (t === 'light') {
    for (const b of sheet) if (!b.media && sel(b).includes(':root[data-theme="light"]')) take(b)
    return vars
  }
  for (const b of sheet) {
    if (how === 'system' && b.media === DARK_QUERY && sel(b).some((s) => s.startsWith(':root'))) take(b)
    if (how === 'attribute' && !b.media && sel(b).includes(':root[data-theme="dark"]')) take(b)
  }
  return vars
}

// oklch(L C H) to its relative luminance (sRGB, WCAG), through OKLab.
function luminance(value: string): number {
  const m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value)
  assert.ok(m, `${value} is an opaque oklch() colour`)
  const L = Number(m[1]) / (m[2] ? 100 : 1)
  const C = Number(m[3])
  const h = (Number(m[4]) * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const clamp = (x: number) => Math.min(1, Math.max(0, x))
  const r = clamp(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s)
  const g = clamp(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s)
  const bl = clamp(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s)
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl
}

function resolve(vars: Map<string, string>, value: string, depth = 0): string {
  const m = /^var\((--[\w-]+)\)$/.exec(value)
  if (!m || depth > 8) return value
  const next = vars.get(m[1] as string)
  assert.ok(next, `${m[1]} is defined`)
  return resolve(vars, next, depth + 1)
}

function contrast(vars: Map<string, string>, ink: string, ground: string): number {
  const a = luminance(resolve(vars, vars.get(ink) ?? `missing ${ink}`))
  const b = luminance(resolve(vars, vars.get(ground) ?? `missing ${ground}`))
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const STATES = ['ok', 'bad', 'warn', 'run', 'neutral']
const CONTRACT = [
  ...['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-8'],
  ...['--r-chip', '--r-control', '--r-card', '--r-sheet'],
  ...['--rail-w-folded', '--rail-w-open', '--rail-bg', '--rail-line', '--rail-ink', '--rail-hover'],
  ...STATES.flatMap((s) => [`--${s}-fg`, `--${s}-bg`, `--${s}-line`]),
  ...['--grid-dot', '--edge', '--node-bg', '--node-line', '--node-ink', '--node-sub'],
  ...['--ease', '--t-fast', '--t'],
  '--page-cap',
]
const COLOURS = CONTRACT.filter((n) =>
  /-(fg|bg|line|ink|sub|hover)$|^--(grid-dot|edge|rail-bg|node-bg)$/.test(n),
)

const sharedBlocks = blocks(shared)
const brain = [...sharedBlocks, ...blocks(tokens)]

describe('shared tokens (shared.css)', () => {
  it('says which version it is, so the copies in both repos can be compared', () => {
    assert.match(shared, /^\/\* shared\.css v\d+ /)
  })

  for (const t of ['light', 'dark'] as const) {
    for (const how of ['system', 'attribute'] as const) {
      it(`hold every name of the contract in ${t} (dark by ${how})`, () => {
        const vars = theme(sharedBlocks, t, how)
        const missing = CONTRACT.filter((n) => !vars.has(n))
        assert.deepEqual(missing, [])
      })
    }
  }

  it('the dark values are the same whether the system or the person asks for dark', () => {
    assert.deepEqual(theme(sharedBlocks, 'dark', 'system'), theme(sharedBlocks, 'dark', 'attribute'))
  })

  it('dark is not light: every colour of the contract has its own dark value', () => {
    const light = theme(sharedBlocks, 'light')
    const dark = theme(sharedBlocks, 'dark')
    const same = COLOURS.filter((n) => light.get(n) === dark.get(n))
    assert.deepEqual(same, [])
  })

  it('the page cap is 2400px and the rail is 56px folded, 220px open', () => {
    const vars = theme(sharedBlocks, 'light')
    assert.equal(vars.get('--page-cap'), '2400px')
    assert.equal(vars.get('--rail-w-folded'), '56px')
    assert.equal(vars.get('--rail-w-open'), '220px')
    assert.deepEqual(
      ['--r-chip', '--r-control', '--r-card', '--r-sheet'].map((n) => vars.get(n)),
      ['4px', '6px', '8px', '14px'],
    )
  })

  it('reduced motion turns the durations to zero', () => {
    const reduced = sharedBlocks.filter((b) => b.media?.includes('prefers-reduced-motion: reduce'))
    const vars = new Map(reduced.flatMap((b) => [...b.vars]))
    assert.equal(vars.get('--t-fast'), '0ms')
    assert.equal(vars.get('--t'), '0ms')
  })

  for (const t of ['light', 'dark'] as const) {
    it(`each state's words read at 4.5:1 on its own ground and on a node, in ${t}`, () => {
      const vars = theme(sharedBlocks, t)
      for (const s of STATES) {
        for (const ground of [`--${s}-bg`, '--node-bg']) {
          const c = contrast(vars, `--${s}-fg`, ground)
          assert.ok(c >= 4.5, `--${s}-fg on ${ground} in ${t}: ${c.toFixed(2)}:1`)
        }
      }
      for (const [ink, ground] of [
        ['--node-ink', '--node-bg'],
        ['--node-sub', '--node-bg'],
        ['--rail-ink', '--rail-bg'],
        ['--rail-ink', '--rail-hover'],
      ] as const) {
        const c = contrast(vars, ink, ground)
        assert.ok(c >= 4.5, `${ink} on ${ground} in ${t}: ${c.toFixed(2)}:1`)
      }
    })
  }
})

describe("Brain's tokens over the shared ones (tokens.css)", () => {
  for (const t of ['light', 'dark'] as const) {
    it(`keep the old names as aliases of the shared ones, in ${t}`, () => {
      const vars = theme(brain, t)
      assert.equal(vars.get('--danger'), 'var(--bad)')
      assert.equal(vars.get('--warning'), 'var(--warn)')
      assert.equal(vars.get('--positive'), 'var(--ok)')
      assert.equal(vars.get('--radius'), 'var(--r-card)')
      for (const s of ['ok', 'bad', 'warn']) assert.equal(vars.get(`--${s}`), `var(--${s}-fg)`)
    })

    it(`the words of the page read at 4.5:1 on its grounds, in ${t}`, () => {
      const vars = theme(brain, t)
      for (const [ink, ground] of [
        ['--text', '--ground'],
        ['--text', '--surface'],
        ['--text', '--raised'],
        ['--muted', '--ground'],
        ['--muted', '--surface'],
        ['--nav', '--ground'],
        ['--primary-fg', '--primary-bg'],
        ['--danger', '--ground'],
        ['--warning', '--ground'],
        ['--positive', '--ground'],
      ] as const) {
        const c = contrast(vars, ink, ground)
        assert.ok(c >= 4.5, `${ink} on ${ground} in ${t}: ${c.toFixed(2)}:1`)
      }
    })
  }

  it('Brain keeps its own accent (hue 156) over the shared sheet', () => {
    for (const t of ['light', 'dark'] as const) assert.match(theme(brain, t).get('--accent') ?? '', / 156\)$/)
  })
})
