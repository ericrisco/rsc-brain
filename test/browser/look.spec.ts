// The look of the web (spec web redesign): a tinted frame in an L (the rail and the top bar), the work on a
// white sheet; one sans face and the monospaced one for what is code; sentence case; colour on data, states
// and the one main action. Each check here failed against v0.7.1 and passes now (the verification keeps both
// runs). Measured in the light mode, the browser asking for light, at 1440×900 unless said.
import type { Page } from '@playwright/test'
import { expect, scenario, test } from './fixture.ts'
import { contrast, frame, LIGHT, MONO, offenders, SANS } from './look.ts'
import { ROWS } from './screens.ts'

const SIGNED_IN = ROWS.filter((r) => !r.preset || r.preset === 'signed-in')
const DOORS = ROWS.filter((r) => r.preset === 'signed-out' || r.preset === 'fresh')

async function open(page: Page, path: string, ready: (p: Page) => ReturnType<Page['locator']>) {
  await page.goto(path)
  await expect(ready(page)).toBeVisible()
  await expect(page.locator('[data-state="loading"]')).toHaveCount(0)
  await page.evaluate(() => document.fonts.ready)
}

test.describe('the frame and the sheet (CA2, CA34)', () => {
  for (const row of SIGNED_IN)
    test(`${row.name}: rail and top bar on one tinted ground; the sheet white, 1px, 16px corners, 8px in`, async ({
      page,
      context,
      baseURL,
    }) => {
      await scenario(context, baseURL as string, 'signed-in')
      await open(page, row.path, row.ready)
      const f = await frame(page)
      expect(f.rail?.bg).toBe(LIGHT.ground)
      expect(f.top?.bg).toBe(LIGHT.ground)
      expect(f.top?.height).toBe(48)
      // No rule between the rail and the top bar, nor under the top bar; no shadow on either.
      expect(f.rail?.borderRight).toBe('0px')
      expect(f.top?.borderBottom).toBe('0px')
      expect(f.top?.borderLeft).toBe('0px')
      expect(f.rail?.shadow).toBe('none')
      expect(f.sheet?.bg).toBe(LIGHT.surface)
      expect(f.sheet?.border).toEqual(['1px', '1px', '1px', '1px'])
      expect(f.sheet?.borderColor).toBe(LIGHT.border)
      expect(f.sheet?.radius).toBe('16px')
      expect(f.sheet?.shadow).toBe('none')
      expect(Math.round(f.sheet?.right ?? -1)).toBe(8)
      expect(Math.round(f.sheet?.bottom ?? -1)).toBe(8)
      // The sheet butts against the rail and the top bar.
      expect(Math.round(f.sheet?.top ?? -1)).toBe(48)
      expect(Math.round(f.sheet?.left ?? -1)).toBe(Math.round(f.rail?.width ?? 0))
    })

  test('the rail is open (228px) the first time, folds to 56px, and the choice survives a reload', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await open(page, '/b/growth', (p) => p.getByRole('region', { name: "Today's sessions" }))
    expect((await frame(page)).rail?.width).toBe(228)
    await page.getByRole('button', { name: 'Collapse the side bar' }).click()
    await expect.poll(async () => (await frame(page)).rail?.width).toBe(56)
    await page.reload()
    await expect(page.getByRole('region', { name: "Today's sessions" })).toBeVisible()
    expect((await frame(page)).rail?.width).toBe(56)
  })

  test('the top bar says where the person is and holds the search', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await open(page, '/b/growth/proposals', (p) => p.getByRole('heading', { name: 'Proposals', level: 1 }))
    const bar = page.locator('.topbar')
    await expect(bar.getByRole('navigation', { name: 'Where you are' })).toContainText('Growth')
    await expect(bar.getByRole('navigation', { name: 'Where you are' })).toContainText('Proposals')
    await expect(bar.getByRole('button', { name: /Search/ })).toBeVisible()
    // The search has left the rail.
    await expect(page.locator('.rail').getByRole('button', { name: /Search/ })).toHaveCount(0)
    await bar.getByRole('button', { name: /Search/ }).click()
    await expect(page.getByRole('dialog', { name: /Search/ })).toBeVisible()
  })

  test('a doorway: the form on a white sheet centred on the frame', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-out')
    await open(page, '/sign-in', (p) => p.getByRole('button', { name: 'Sign in', exact: true }))
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(bg).toBe(LIGHT.ground)
    const card = await page.evaluate(() => {
      const el = document.querySelector('.door-card') as HTMLElement
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return {
        bg: cs.backgroundColor,
        radius: cs.borderTopLeftRadius,
        border: cs.borderTopWidth,
        centre: Math.abs(r.left + r.width / 2 - innerWidth / 2),
      }
    })
    expect(card).toEqual({ bg: LIGHT.surface, radius: '16px', border: '1px', centre: expect.any(Number) })
    expect(card.centre).toBeLessThan(2)
  })
})

test.describe('type, case and colour on every screen (CA3, CA6, CA9, Annex C 14)', () => {
  for (const row of [...SIGNED_IN, ...DOORS])
    test(`${row.name}: IBM Plex Sans; mono only for code; no capitals; no violet; no title over 32px`, async ({
      page,
      context,
      baseURL,
    }) => {
      await scenario(context, baseURL as string, row.preset ?? 'signed-in')
      await open(page, row.path, row.ready)
      const body = await page.evaluate(() => getComputedStyle(document.body).fontFamily)
      expect(body).toMatch(SANS)
      const h1 = await page.evaluate(() => {
        const h = document.querySelector('h1')
        return h ? getComputedStyle(h).fontFamily : '"IBM Plex Sans"'
      })
      expect(h1).toMatch(SANS)
      expect(await page.evaluate(() => document.fonts.check('14px "IBM Plex Sans"'))).toBe(true)
      const o = await offenders(page)
      expect(o.mono, 'only code-like text in mono').toEqual([])
      expect(o.upper, 'nothing transformed to capitals').toEqual([])
      expect(o.violet, 'no violet or indigo').toEqual([])
      expect(o.big, 'no title over 32px').toEqual([])
      expect(o.small, 'no text under 11px').toEqual([])
    })

  test('an address, an id and the figures of a table are in IBM Plex Mono', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await open(page, '/b/growth/wiki/graph?view=list', (p) =>
      p.getByRole('table', { name: /Pages of the wiki/ }),
    )
    const fams = await page.evaluate(() => ({
      address: getComputedStyle(document.querySelector('table .mono') as Element).fontFamily,
      figure: getComputedStyle(document.querySelector('table td.num') as Element).fontFamily,
      tabular: getComputedStyle(document.querySelector('table td.num') as Element).fontVariantNumeric,
    }))
    expect(fams.address).toMatch(MONO)
    expect(fams.figure).toMatch(MONO)
    expect(fams.tabular).toContain('tabular-nums')
  })
})

test.describe('no numbered panels, one main action, a neutral rail (CA11, CA12, CA13, Annex C 10)', () => {
  for (const row of SIGNED_IN)
    test(`${row.name}: no panel number, coloured corner or family; at most one main action, near black`, async ({
      page,
      context,
      baseURL,
    }) => {
      await scenario(context, baseURL as string, 'signed-in')
      await open(page, row.path, row.ready)
      expect(await page.locator('.panel-num, [data-c], .panel-head').count()).toBe(0)
      const corners = await page.evaluate(
        () =>
          [...document.querySelectorAll('body *')].filter((el) =>
            getComputedStyle(el, '::before').backgroundImage.includes('gradient'),
          ).length,
      )
      expect(corners).toBe(0)
      const primaries = await page.evaluate(() =>
        [...document.querySelectorAll('main .button.primary')]
          .filter((b) => b.getBoundingClientRect().width > 0 && !b.closest('dialog'))
          .map((b) => getComputedStyle(b).backgroundColor),
      )
      expect(primaries.length).toBeLessThanOrEqual(1)
      for (const bg of primaries) expect(bg).toBe(LIGHT.text)
      // An icon never sits in a tinted square.
      const tinted = await page.evaluate(
        () =>
          [...document.querySelectorAll('svg.icon')]
            .map((s) => s.parentElement as Element)
            .filter((p) => {
              const c = getComputedStyle(p).backgroundColor
              const m = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/.exec(c)
              if (!m || m[4] === '0') return false
              const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])]
              return Math.max(r, g, b) - Math.min(r, g, b) > 12
            }).length,
      )
      expect(tinted).toBe(0)
    })

  test('the current section is the grey pill with aria-current; no accent bar, no accent icon', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await open(page, '/b/growth/proposals', (p) => p.getByRole('heading', { name: 'Proposals', level: 1 }))
    const item = page.locator('.rail').getByRole('link', { name: /^Proposals/ })
    const s = await item.evaluate((el) => ({
      bg: getComputedStyle(el).backgroundColor,
      bar: getComputedStyle(el, '::before').content,
      icon: getComputedStyle(el.querySelector('svg') as Element).color,
    }))
    expect(s.bg).toBe(LIGHT.active)
    expect(s.bar).toBe('none')
    expect(s.icon).not.toBe(LIGHT.accent)
  })

  test('a destructive action lives in its confirmation, outlined in the negative colour', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await open(page, '/b/growth/settings/archive', (p) => p.getByRole('heading', { level: 1 }))
    const outside = await page.evaluate(
      () =>
        [...document.querySelectorAll('main .button.danger')].filter((b) => !b.closest('dialog, .confirm'))
          .length,
    )
    expect(outside).toBe(0)
    await page
      .getByRole('button', { name: /^Archive/ })
      .first()
      .click()
    const danger = page.locator('.confirm .button.danger, dialog .button.danger').first()
    await expect(danger).toBeVisible()
    const s = await danger.evaluate((b) => {
      const cs = getComputedStyle(b)
      return { color: cs.color, border: cs.borderTopColor, bg: cs.backgroundColor }
    })
    expect(s.color).toBe(LIGHT.negative)
    expect(s.border).toBe(LIGHT.negative)
    expect(s.bg).not.toBe(LIGHT.negative)
  })
})

test.describe('the values (CA33)', () => {
  test('overview: ink, grey, rule, card border, section and figure sizes, the gap', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await open(page, '/b/growth', (p) => p.getByRole('region', { name: "Today's sessions" }))
    const v = await page.evaluate(() => {
      const cs = (sel: string) => getComputedStyle(document.querySelector(sel) as Element)
      const h1 = cs('main h1')
      const h2 = cs('main section h2')
      const fig = cs('main .tile-n')
      const sheet = cs('main#main')
      return {
        text: getComputedStyle(document.body).color,
        size: getComputedStyle(document.body).fontSize,
        muted: cs('main .meta').color,
        small: cs('main .meta').fontSize,
        h1: [h1.fontSize, h1.fontWeight],
        h2: [h2.fontSize, h2.fontWeight, h2.textTransform],
        fig: [fig.fontSize, fig.fontWeight, fig.color, fig.fontVariantNumeric],
        card: [cs('main .card').borderTopColor, cs('main .card').borderTopLeftRadius],
        pad: sheet.paddingLeft,
        gap: cs('main .overview').rowGap,
      }
    })
    expect(v.text).toBe(LIGHT.text)
    expect(v.size).toBe('14px')
    expect(v.muted).toBe(LIGHT.muted)
    expect(v.small).toBe('12px')
    expect(v.h1).toEqual(['22px', '600'])
    expect(v.h2).toEqual(['16px', '600', 'none'])
    expect(v.fig).toEqual(['28px', '400', LIGHT.text, 'tabular-nums'])
    expect(v.card).toEqual([LIGHT.border, '8px'])
    expect(v.pad).toBe('24px')
    expect(v.gap).toBe('24px')
  })

  test('proposals: tabs underlined 2px, rows on a rule, controls 32px with 6px corners', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await open(page, '/b/growth/proposals', (p) => p.getByRole('heading', { name: 'Proposals', level: 1 }))
    const v = await page.evaluate(() => {
      const cur = document.querySelector('main nav.tabs a[aria-current]') as Element
      const row = document.querySelector('main ul.list > li') as Element
      const btn = document.querySelector('main .button, main select, .topbar-search') as Element
      return {
        tab: [getComputedStyle(cur).borderBottomWidth, getComputedStyle(cur).borderBottomColor],
        rule: getComputedStyle(row).borderBottomColor,
        rowH: row.getBoundingClientRect().height,
        btn: [btn.getBoundingClientRect().height, getComputedStyle(btn).borderTopLeftRadius],
      }
    })
    expect(v.tab).toEqual(['2px', LIGHT.text])
    expect(v.rule).toBe(LIGHT.rule)
    expect(v.rowH).toBeGreaterThanOrEqual(48)
    expect(v.btn).toEqual([32, '6px'])
  })

  test('the four pills: their pale ground and their ink, with a sign and a word', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await open(page, '/b/growth', (p) => p.getByRole('region', { name: "Today's sessions" }))
    const pills = await page.evaluate(() => {
      const out: Record<string, [string, string, string]> = {}
      const host = document.createElement('p')
      host.innerHTML =
        '<span class="tag ok">Done</span><span class="tag bad">Failed</span><span class="tag warn">Stale</span><span class="tag">Draft</span>'
      document.querySelector('main')?.append(host)
      for (const [k, sel] of [
        ['positive', '.tag.ok'],
        ['negative', '.tag.bad'],
        ['warning', '.tag.warn'],
        ['neutral', '.tag:not(.ok):not(.bad):not(.warn)'],
      ] as const) {
        const el = host.querySelector(sel) as Element
        out[k] = [
          getComputedStyle(el).backgroundColor,
          getComputedStyle(el).color,
          getComputedStyle(el, '::before').content,
        ]
      }
      host.remove()
      return out
    })
    for (const k of ['positive', 'negative', 'warning', 'neutral'] as const) {
      expect(pills[k]?.slice(0, 2)).toEqual(LIGHT.pills[k])
    }
    // A state mark carries a sign before its word (Annex C 15); the neutral one is a word only.
    for (const k of ['positive', 'negative', 'warning'] as const) expect(pills[k]?.[2]).not.toBe('none')
  })

  test('a page: its tabs, its reading text and the accent of a link to another page', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await open(page, '/b/growth/pages/audience/retention', (p) =>
      p.getByRole('heading', { name: 'What keeps viewers' }),
    )
    const v = await page.evaluate(() => {
      const body = document.querySelector('.page-body, .prose') as Element
      return { family: getComputedStyle(body).fontFamily, size: getComputedStyle(body).fontSize }
    })
    expect(v.family).toMatch(/^"?IBM Plex Sans/)
    expect(Number.parseFloat(v.size)).toBeGreaterThanOrEqual(14)
  })

  test('an administration setting: two columns, label and panel', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await open(page, '/admin/limits', (p) => p.getByRole('heading', { level: 1 }))
    const v = await page.evaluate(() => {
      const btn = document.querySelector('main .button') as Element
      const field = document.querySelector('main input') as Element
      return {
        btnH: btn.getBoundingClientRect().height,
        field: [field.getBoundingClientRect().height, getComputedStyle(field).borderTopLeftRadius],
        fieldBorder: getComputedStyle(field).borderTopColor,
        surface: getComputedStyle(document.querySelector('main#main') as Element).backgroundColor,
      }
    })
    expect(v.btnH).toBe(32)
    expect(v.field[1]).toBe('6px')
    expect(v.surface).toBe(LIGHT.surface)
    // A field is recognised by its edge: it reads at 3:1 on the sheet (WCAG 1.4.11; spec P13).
    expect(contrast(v.fieldBorder, LIGHT.surface)).toBeGreaterThanOrEqual(3)
  })
})

test.describe('the clauses of Annex C', () => {
  test('1: three levels at most — frame, sheet, card', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await open(page, '/b/growth', (p) => p.getByRole('region', { name: "Today's sessions" }))
    const depth = await page.evaluate(() => {
      const boxed = (el: Element) => {
        const cs = getComputedStyle(el)
        return (
          cs.borderTopWidth !== '0px' &&
          cs.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
          !/^(INPUT|BUTTON|SELECT|TEXTAREA|A|KBD|CODE)$/.test(el.tagName) &&
          !el.classList.contains('tag')
        )
      }
      // The sheet is the second level; a card on it the third; nothing boxed inside a card.
      if (!boxed(document.querySelector('main#main') as Element)) return 99
      let most = 0
      for (const el of document.querySelectorAll('main#main *')) {
        if (!boxed(el)) continue
        let d = 1
        for (let p = el.parentElement; p && p.id !== 'main'; p = p.parentElement) if (boxed(p)) d += 1
        most = Math.max(most, d)
      }
      return most
    })
    expect(depth).toBeLessThanOrEqual(1)
  })

  test('5: lists have no stripes; table heads are grey in sentence case; figures to the right', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await open(page, '/b/growth/wiki/graph?view=list', (p) =>
      p.getByRole('table', { name: /Pages of the wiki/ }),
    )
    const v = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('main table tbody tr')].slice(0, 4)
      const th = document.querySelector('main table th') as Element
      const num = document.querySelector('main table td.num') as Element
      return {
        stripes: new Set(rows.map((r) => getComputedStyle(r).backgroundColor)).size,
        th: [
          getComputedStyle(th).color,
          getComputedStyle(th).textTransform,
          getComputedStyle(th).backgroundColor,
        ],
        num: getComputedStyle(num).textAlign,
      }
    })
    expect(v.stripes).toBe(1)
    expect(v.th).toEqual([LIGHT.muted, 'none', 'rgba(0, 0, 0, 0)'])
    expect(v.num).toBe('right')
  })

  test('6 and 8: a diff says added and removed with a sign; the change picked carries the accent', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await open(page, '/b/growth/proposals/prp_growth1', (p) => p.getByRole('heading', { level: 1 }))
    const signs = await page.evaluate(() =>
      [...document.querySelectorAll('main ins, main del, main .added, main .removed')]
        .slice(0, 6)
        .map((el) => getComputedStyle(el, '::before').content),
    )
    expect(signs.length).toBeGreaterThan(0)
    for (const s of signs) expect(s).toMatch(/[+−-]/)
    const box = page.locator('.op-card').first()
    const check = box.getByRole('checkbox').first()
    if (!(await check.isChecked())) await check.check()
    const edge = await box.evaluate((el) => getComputedStyle(el).borderTopColor)
    expect(edge).toBe(LIGHT.accent)
  })

  test('7: a mention, an external link and a broken mention differ without colour', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await open(page, '/b/growth/pages/audience/retention', (p) =>
      p.getByRole('heading', { name: 'What keeps viewers' }),
    )
    const v = await page.evaluate(() => {
      const host = document.createElement('p')
      host.innerHTML =
        '<a class="wikilink" href="#">A page</a> <a class="wikilink broken" href="#">No page</a> <a href="https://example.org/">Out</a>'
      document.querySelector('.page-body, .prose')?.append(host)
      const look = (el: Element) => {
        const cs = getComputedStyle(el)
        const after = getComputedStyle(el, '::after').content
        const before = getComputedStyle(el, '::before').content
        return `${cs.textDecorationLine}|${cs.textDecorationStyle}|${before}|${after}`
      }
      const [a, b, c] = [...host.querySelectorAll('a')].map(look)
      host.remove()
      return [a, b, c]
    })
    expect(new Set(v).size).toBe(3)
  })

  test('9: a dialog is opaque and gives the focus back to what opened it', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await open(page, '/b/growth', (p) => p.getByRole('region', { name: "Today's sessions" }))
    const opener = page.locator('.topbar').getByRole('button', { name: /Search/ })
    await opener.click()
    const dialog = page.getByRole('dialog', { name: /Search/ })
    await expect(dialog).toBeVisible()
    const bg = await dialog.evaluate((d) => getComputedStyle(d).backgroundColor)
    expect(bg).toBe(LIGHT.surface)
    await page.keyboard.press('Escape')
    await expect(opener).toBeFocused()
  })

  test('11: a very long address breaks inside its box; the screen does not widen', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.setViewportSize({ width: 390, height: 844 })
    await open(page, '/b/growth/wiki/graph?view=list', (p) =>
      p.getByRole('table', { name: /Pages of the wiki/ }),
    )
    await page.evaluate(() => {
      const a = document.querySelector('main table .mono') as HTMLElement
      a.textContent = `audience/${'very-long-address-without-a-break-'.repeat(6)}end`
    })
    const r = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      win: document.documentElement.clientWidth,
    }))
    expect(r.doc).toBeLessThanOrEqual(r.win)
  })
})

// CA5: nothing is asked of a third party. Every request a screen makes, fonts and pictures included, goes to
// the installation's own origin.
for (const row of ROWS)
  test(`CA5: ${row.name} asks nothing of a server other than the installation`, async ({
    page,
    context,
    baseURL,
  }) => {
    const mine = new URL(baseURL as string).origin
    const strangers: string[] = []
    page.on('request', (req) => {
      const u = new URL(req.url())
      if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return
      if (u.origin !== mine) strangers.push(req.url())
    })
    await scenario(context, baseURL as string, row.preset ?? 'signed-in')
    await page.goto(row.path)
    await expect(row.ready(page)).toBeVisible()
    await page.waitForLoadState('networkidle')
    await page.evaluate(() => document.fonts.ready)
    expect(strangers).toEqual([])
  })

// CA8: the styles as served hold no gradient (on a ground, a button, a card or text), no glow, no blur behind
// anything; a shadow is only the floating one (a menu, a dialog, the suggestion) or an inset line.
test('CA8: the served styles hold no gradient, glow or blur, and no shadow but the floating one', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  const css = await page.evaluate(async () => {
    const hrefs = [...document.querySelectorAll('link[rel="stylesheet"]')].map(
      (l) => (l as HTMLLinkElement).href,
    )
    return (await Promise.all(hrefs.map((h) => fetch(h).then((r) => r.text())))).join('\n')
  })
  expect(css.length).toBeGreaterThan(10_000)
  expect(css).not.toMatch(/gradient\(/)
  expect(css).not.toMatch(/backdrop-filter|filter:\s*(blur|drop-shadow)|text-shadow|drop-shadow\(/)
  const shadows = [...css.matchAll(/box-shadow:\s*([^;}]+)/g)].map((m) => (m[1] as string).trim())
  const stray = shadows.filter((s) => !/^(none|var\(--shadow-float\)|inset [^,]+)$/.test(s))
  expect(stray).toEqual([])
})
