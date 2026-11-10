// Plan canvas-ui §0, B1 and S.0 (shared.css v2): the shared tokens (the same file in rsc-brain and
// rsc-factory) hold the contract's names in both themes, dark on :root (the default) and light when the person
// chooses it (data-theme on <html>); the seven family colours, each with a dim variant; the monospaced stack
// with its self-hosted font; the panel classes with their coloured corners; the glow and pulse tokens. Brain's
// own tokens keep the old names as aliases of the new ones, and every pair of ink and ground meant to be read
// passes 4.5:1 (WCAG 2.2 AA) in light and in dark.
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

// What a theme sees: the values on :root (dark, the default), then, in light, the light ones over them, and in
// dark the ones the person's explicit choice sets (data-theme="dark", the same values).
function theme(sheet: Block[], t: 'light' | 'dark') {
  const vars = new Map<string, string>()
  const take = (b: Block) => {
    for (const [k, v] of b.vars) vars.set(k, v)
  }
  const sel = (b: Block) => b.selector.split(',').map((s) => s.trim())
  for (const b of sheet) if (!b.media && sel(b).includes(':root')) take(b)
  for (const b of sheet) if (!b.media && sel(b).includes(`:root[data-theme="${t}"]`)) take(b)
  return vars
}
// Only :root, with no attribute: what a first visit sees before any choice.
function first(sheet: Block[]) {
  const vars = new Map<string, string>()
  for (const b of sheet)
    if (!b.media && b.selector.split(',').some((s) => s.trim() === ':root'))
      for (const [k, v] of b.vars) vars.set(k, v)
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
const FAMILIES = ['orange', 'amber', 'blue', 'cyan', 'pink', 'violet', 'green']
const CONTRACT = [
  ...['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-8'],
  ...['--r-chip', '--r-control', '--r-card', '--r-sheet'],
  ...['--rail-w-folded', '--rail-w-open', '--rail-bg', '--rail-line', '--rail-ink', '--rail-hover'],
  ...STATES.flatMap((s) => [`--${s}-fg`, `--${s}-bg`, `--${s}-line`]),
  ...['--grid-dot', '--edge', '--node-bg', '--node-line', '--node-ink', '--node-sub'],
  ...['--ease', '--t-fast', '--t'],
  '--page-cap',
  ...FAMILIES.flatMap((f) => [`--fam-${f}`, `--fam-${f}-dim`]),
  ...['--font-mono', '--panel-bg', '--panel-line', '--panel-head-bg', '--panel-ink'],
  ...['--glow', '--glow-strong', '--pulse', '--pulse-len', '--pulse-speed'],
]
const COLOURS = CONTRACT.filter((n) =>
  /-(fg|bg|line|ink|sub|hover|dim)$|^--(grid-dot|edge|rail-bg|node-bg)$|^--fam-[a-z]+$/.test(n),
)

const sharedBlocks = blocks(shared)
const brain = [...sharedBlocks, ...blocks(tokens)]

describe('shared tokens (shared.css)', () => {
  it('says which version it is, so the copies in both repos can be compared', () => {
    assert.match(shared, /^\/\* shared\.css v\d+ /)
  })

  for (const t of ['light', 'dark'] as const) {
    it(`hold every name of the contract in ${t}`, () => {
      const vars = theme(sharedBlocks, t)
      const missing = CONTRACT.filter((n) => !vars.has(n))
      assert.deepEqual(missing, [])
    })
  }

  it('dark is the default: :root alone holds the dark values, the same the dark choice sets', () => {
    const root = first(sharedBlocks)
    const dark = theme(sharedBlocks, 'dark')
    for (const n of COLOURS) assert.equal(root.get(n), dark.get(n), n)
    // No block waits for the system to say dark: dark needs no media query.
    assert.equal(
      sharedBlocks.some((b) => b.media?.includes('prefers-color-scheme')),
      false,
    )
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

  it('the monospaced stack starts with the self-hosted font and falls back to the system ones', () => {
    const mono = theme(sharedBlocks, 'dark').get('--font-mono') ?? ''
    assert.match(mono, /^"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas/)
    const faces = [...shared.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1] ?? '')
    assert.ok(faces.length >= 2, 'a regular and a bold face')
    for (const f of faces) {
      assert.match(f, /font-family:\s*"JetBrains Mono"/)
      assert.match(f, /font-display:\s*swap/)
      // Served from the same origin (the CSP's font-src 'self'): a relative file, never a URL elsewhere.
      assert.match(f, /src:\s*url\("\.\/fonts\/[\w.-]+\.woff2"\)\s*format\("woff2"\)/)
    }
    for (const f of faces) {
      const file = /url\("\.\/fonts\/([\w.-]+)"\)/.exec(f)?.[1] as string
      assert.ok(readFileSync(new URL(`fonts/${file}`, STYLES)).length > 10_000, `${file} is there`)
    }
    assert.match(readFileSync(new URL('fonts/OFL.txt', STYLES), 'utf8'), /SIL OPEN FONT LICENSE Version 1\.1/)
  })

  it('a panel has coloured corners from --panel-c, a numbered chip and a head', () => {
    const text = shared.replace(/\/\*[\s\S]*?\*\//g, '')
    for (const cls of ['.panel', '.panel-head', '.panel-num'])
      assert.match(text, new RegExp(`(^|[\\s,}])\\${cls}\\s*[{,]`), `${cls} is styled`)
    // The corners and the chip take the panel's colour; a panel without one is orange.
    assert.match(text, /\.panel\s*\{[^}]*--panel-c:\s*var\(--fam-orange\)/)
    assert.match(text, /\.panel::before\s*\{[^}]*var\(--panel-c\)/)
    assert.match(text, /\.panel-num\s*\{[^}]*background:\s*var\(--panel-c\)/)
    // Any element takes a family by data-c: a panel, a figure in it, a pill.
    for (const f of FAMILIES)
      assert.match(text, new RegExp(`(^|\\s)\\[data-c="${f}"\\]\\s*\\{\\s*--panel-c:\\s*var\\(--fam-${f}\\)`))
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
      for (const f of FAMILIES) {
        // A family's colour is read as words (a panel's meta, a figure, a legend count) on a panel and on the
        // page; its dim variant is the ground of its pill, where the panel's ink is written.
        for (const ground of ['--panel-bg', '--panel-head-bg', '--node-bg']) {
          const c = contrast(vars, `--fam-${f}`, ground)
          assert.ok(c >= 4.5, `--fam-${f} on ${ground} in ${t}: ${c.toFixed(2)}:1`)
        }
        const pill = contrast(vars, '--panel-ink', `--fam-${f}-dim`)
        assert.ok(pill >= 4.5, `--panel-ink on --fam-${f}-dim in ${t}: ${pill.toFixed(2)}:1`)
        // The numbered chip: the panel's ground written on the family colour.
        const chip = contrast(vars, '--panel-bg', `--fam-${f}`)
        assert.ok(chip >= 4.5, `--panel-bg on --fam-${f} in ${t}: ${chip.toFixed(2)}:1`)
      }
      for (const [ink, ground] of [
        ['--panel-ink', '--panel-bg'],
        ['--panel-ink', '--panel-head-bg'],
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

  // v0.5.0: the graph's communities, dots on the canvas's ground: each colour stands out from the ground
  // (3:1, WCAG 1.4.11 for graphics) and from the other nine, and the two greys from both.
  for (const t of ['light', 'dark'] as const) {
    it(`the communities' colours stand out from the ground and from each other, in ${t}`, () => {
      const vars = theme(brain, t)
      const names = [...Array.from({ length: 10 }, (_, k) => `--com-${k}`), '--com-other', '--com-lone']
      for (const n of names) {
        const c = contrast(vars, n, '--ground')
        assert.ok(c >= 3, `${n} on --ground in ${t}: ${c.toFixed(2)}:1`)
      }
      // Two colours differ in hue or clearly in lightness (OKLCH, as written).
      const lch = (n: string) => {
        const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(vars.get(n) ?? '')
        assert.ok(m, `${n} is an oklch() colour`)
        return [Number(m[1]), Number(m[2]), Number(m[3])] as const
      }
      for (let a = 0; a < names.length; a++)
        for (let b = a + 1; b < names.length; b++) {
          const [la, ca, ha] = lch(names[a] as string)
          const [lb, cb, hb] = lch(names[b] as string)
          const hue = Math.min(Math.abs(ha - hb), 360 - Math.abs(ha - hb))
          const apart =
            (ca > 0.05 && cb > 0.05 && hue >= 25) || Math.abs(la - lb) >= 0.08 || Math.abs(ca - cb) >= 0.06
          assert.ok(apart, `${names[a]} and ${names[b]} too alike in ${t}`)
        }
    })
  }

  it('Brain keeps its own accent (hue 156) over the shared sheet', () => {
    for (const t of ['light', 'dark'] as const) assert.match(theme(brain, t).get('--accent') ?? '', / 156\)$/)
  })
})
