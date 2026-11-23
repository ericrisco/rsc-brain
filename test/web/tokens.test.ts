// The shared tokens (the same file in rsc-brain and rsc-factory, byte for byte) and Brain's own over them
// (spec web redesign, «Los valores», «Los tres modos»; CA26, CA27, CA33). The light mode holds the values of
// the table; dark and high contrast hold their own; every ink meant to be read passes 4.5:1 in light and dark
// and 7:1 in high contrast, every edge that is all a control shows reaches 3:1 (4.5:1 in high contrast). The
// faces are self-hosted with their licence. With no choice the sheet follows the system.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
// The dark mode's values of shared.css v4 (raised by the review of the redesign, for both repositories).
export const DARK: Record<string, string> = {
  '--ground': '#0a0b0c',
  '--surface': '#1a1b1d',
  '--raised': '#222427',
  '--active': '#2c2e32',
  '--border': '#45474b',
  '--rule': '#303236',
  '--control': '#7a7e84',
  '--control-strong': '#868a90',
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

  // The digests both repos carry: change shared.css or a face in either and this fails in every run, with no
  // need to have the other repo at hand. When the shared files change on purpose, both repos take the new ones.
  const PINNED: Record<string, string> = {
    'shared.css': 'ac16c38fb5624b6f3476de21f507f9332c900b28d2f62ec94b27cdc8a26ea41a',
    'fonts/OFL.txt': '7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da',
    'fonts/ibm-plex-mono-latin1-400.woff2':
      'e8993d946649b9d01abb1ed06d574b19d8ea3e66b5c3948602db335c44c18e56',
    'fonts/ibm-plex-mono-latin1-500.woff2':
      '41201b658a328b9d00368215c2f1102770f80b15952ab82631e4006255e6365d',
    'fonts/ibm-plex-sans-latin1-400.woff2':
      'bdb53f2af84b15e0a742428f5e199dacc3e6fd60776f0aebd9f700e2c97c960f',
    'fonts/ibm-plex-sans-latin1-500.woff2':
      '668a0d9eabbfac0925f431988f56222b8b989ad66a0a78e91bc5889f73fe274a',
    'fonts/ibm-plex-sans-latin1-600.woff2':
      '8251b7fc61b580c2f52550fa69b3c49fb94fc333815ad301ca6b1f6d15420f85',
  }
  it('carries the pinned shared.css and faces of both repos, byte for byte (CA26)', () => {
    const have = ['shared.css', ...readdirSync(new URL('fonts/', STYLES)).map((f) => `fonts/${f}`)].sort()
    assert.deepEqual(have, Object.keys(PINNED).sort())
    for (const [f, sha] of Object.entries(PINNED))
      assert.equal(
        createHash('sha256')
          .update(readFileSync(new URL(f, STYLES)))
          .digest('hex'),
        sha,
        f,
      )
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

  // Dark's values of shared.css were provisional; tokens.css raises them (review of the redesign, finding 13).
  // Chosen or asked by the system, they are the same, and every one is held to its floor.
  it('dark: edges, muted words, pills and the quiet graph are raised, chosen or asked by the system', () => {
    const asked = new Map(chosen(sharedBlocks, 'dark'))
    for (const b of blocks(tokens))
      if (b.media?.includes('prefers-color-scheme: dark') && b.selector === ':root:not([data-theme])')
        for (const [k, v] of b.vars) asked.set(k, v)
    const picked = chosen(brain, 'dark')
    for (const vars of [picked, asked]) {
      // A control's edge (shared.css v4), on the sheet and on the graph's well: 3:1.
      for (const ground of ['--surface', '--raised'])
        assert.ok(contrast(vars, '--control-strong', ground) >= 3, `--control-strong on ${ground}`)
      assert.ok(contrast(vars, '--control', '--surface') >= 3, '--control on --surface')
      // Muted words, on every ground they sit on: 4.5:1.
      for (const ground of ['--surface', '--raised', '--active', '--pill-neutral-bg'])
        assert.ok(contrast(vars, '--muted', ground) >= 4.5, `--muted on ${ground}`)
      // The edge of the sheet and the cards reads against the frame and the sheet; the neutral pill against the sheet.
      assert.ok(contrast(vars, '--border', '--surface') >= 1.6, '--border on --surface')
      assert.ok(contrast(vars, '--border', '--ground') >= 1.6, '--border on --ground')
      assert.ok(contrast(vars, '--pill-neutral-bg', '--surface') >= 1.4, 'neutral pill on the sheet')
      assert.ok(contrast(vars, '--pill-positive-bg', '--surface') >= 1.9, 'a diff addition on the sheet')
      // The graph's quiet pages and links on its well.
      for (const k of ['--graph-node', '--graph-lone', '--edge'])
        assert.ok(contrast(vars, k, '--raised') >= 4.5, `${k} on --raised`)
    }
  })

  it('light and high contrast keep the values of before (the review raises dark only)', () => {
    const light = chosen(brain, 'light')
    for (const [k, v] of Object.entries({
      '--border': '#e8eaec',
      '--rule': '#f0f1f2',
      '--control-strong': '#878a8e',
      '--muted': '#5d5f60',
      '--pill-neutral-bg': '#ebedee',
      '--pill-positive-bg': '#dcfae5',
      '--edge': '#9a9da1',
      '--graph-node': '#6b6e72',
      '--graph-lone': '#b4b7ba',
    }))
      assert.equal(light.get(k), v, k)
    const high = chosen(brain, 'contrast')
    for (const [k, v] of Object.entries({
      '--border': '#595959',
      '--control-strong': '#595959',
      '--muted': '#3d3d3d',
      '--edge': '#595959',
      '--graph-node': '#3d3d3d',
      '--graph-lone': '#767676',
    }))
      assert.equal(high.get(k), v, k)
  })

  it('the pick in the graph has a thicker ring in high contrast', () => {
    assert.equal(chosen(brain, 'light').get('--graph-ring'), '2.5')
    assert.equal(chosen(brain, 'contrast').get('--graph-ring'), '4')
  })
})
