// CA14 (spec web redesign, «El grafo»): a flat ground with no dots; the pages in neutral tones; the page
// picked (and its links) in the accent, the rest dimmed; in high contrast the pick also has a thicker ring.
// The picture is read from a screenshot of the canvas, pixel by pixel, in the page.
import type { Page } from '@playwright/test'
import { expect, scenario, test } from './fixture.ts'

const GRAPH = '/b/growth/wiki/graph'
const settled = (page: Page) =>
  expect(page.locator('canvas.graph-canvas[data-settled]')).toHaveCount(1, { timeout: 20_000 })

// How many pixels of the canvas carry a hue (saturation over 35%), and how many are near the accent's hue.
async function hues(page: Page, accentHue: number) {
  const canvas = page.locator('canvas.graph-canvas')
  const shot = (await canvas.screenshot()).toString('base64')
  return page.evaluate(
    async ({ shot, accentHue }) => {
      const img = new Image()
      img.src = `data:image/png;base64,${shot}`
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.width
      c.height = img.height
      const ctx = c.getContext('2d') as CanvasRenderingContext2D
      ctx.drawImage(img, 0, 0)
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      let coloured = 0
      let accent = 0
      for (let i = 0; i < d.length; i += 4) {
        const r = (d[i] as number) / 255
        const g = (d[i + 1] as number) / 255
        const b = (d[i + 2] as number) / 255
        const max = Math.max(r, g, b)
        const min = Math.min(r, g, b)
        const l = (max + min) / 2
        const delta = max - min
        if (delta < 0.12) continue
        const s = delta / (1 - Math.abs(2 * l - 1))
        if (s < 0.35) continue
        coloured += 1
        let h = 0
        if (max === r) h = ((g - b) / delta) % 6
        else if (max === g) h = (b - r) / delta + 2
        else h = (r - g) / delta + 4
        h = (h * 60 + 360) % 360
        if (Math.abs(h - accentHue) < 18) accent += 1
      }
      return { coloured, accent, total: d.length / 4 }
    },
    { shot, accentHue },
  )
}

// The accent's hue (192° for #1b6c80 and its lighter and darker kin).
const ACCENT_HUE = 192

for (const mode of ['light', 'dark', 'contrast'] as const)
  test(`CA14 in ${mode}: flat ground without dots, neutral pages, the pick and its links in the accent`, async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.addInitScript((m) => localStorage.setItem('rscb.theme', m), mode)
    await page.goto(GRAPH)
    await settled(page)
    const ground = await page.evaluate(() => {
      const box = document.querySelector('.graph-box') as Element
      return { image: getComputedStyle(box).backgroundImage, bg: getComputedStyle(box).backgroundColor }
    })
    expect(ground.image).toBe('none')
    const atRest = await hues(page, ACCENT_HUE)
    // At rest nothing on the canvas carries a hue: the pages are neutral.
    expect(atRest.coloured / atRest.total).toBeLessThan(0.0005)
    const canvas = page.locator('canvas.graph-canvas')
    await canvas.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('link', { name: 'Open page' })).toBeVisible()
    await page.mouse.move(0, 0)
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const picked = await hues(page, ACCENT_HUE)
    expect(picked.accent).toBeGreaterThan(20)
    // Everything with a hue is the accent: no other colour on the picture.
    expect(picked.accent / picked.coloured).toBeGreaterThan(0.9)
    const rings = (await canvas.getAttribute('data-rings')) ?? ''
    const sel = /selected:solid:[\d.]+:([\d.]+)/.exec(rings)
    expect(sel, rings).not.toBeNull()
    // The ring of the pick is thicker in high contrast: not by colour alone.
    expect(Number(sel?.[1])).toBe(mode === 'contrast' ? 4 : 2.5)
  })

test('CA14: the communities panel names its clusters with no colour dots', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.goto(GRAPH)
  await settled(page)
  const dots = await page.evaluate(
    () =>
      [...document.querySelectorAll('.graph-communities *')].filter((el) => {
        const c = getComputedStyle(el).backgroundColor
        const m = /rgba?\((\d+), (\d+), (\d+)/.exec(c)
        if (!m) return false
        const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])]
        return Math.max(r, g, b) - Math.min(r, g, b) > 24
      }).length,
  )
  expect(dots).toBe(0)
  expect(await page.locator('.graph-communities .com-dot').count()).toBe(0)
})

test('CA14: a mode change repaints the graph at once, keeping the page picked', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.goto(GRAPH)
  await settled(page)
  const canvas = page.locator('canvas.graph-canvas')
  await canvas.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('link', { name: 'Open page' })).toBeVisible()
  const before = await canvas.getAttribute('data-draws')
  await page
    .locator('.rail')
    .getByRole('button', { name: /Account/ })
    .click()
  await page.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Dark', exact: true }).click()
  await expect.poll(() => canvas.getAttribute('data-draws')).not.toBe(before)
  await expect(page.getByRole('link', { name: 'Open page' })).toBeVisible()
})

// With the inspector open: the page chosen and its name stay in the clear, the help for the keys is not over the
// drawing, the strike-through has its legend, and the focus ring of the picture is whole on four sides.
for (const mode of ['light', 'dark', 'contrast'] as const)
  test(`graph with the inspector open (${mode}): the chosen page and its name are clear of every panel`, async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.addInitScript((m) => localStorage.setItem('rscb.theme', m), mode)
    await page.goto(GRAPH)
    await settled(page)
    // The legend of the struck-through pages, and the help behind its button, not over the picture.
    await expect(page.locator('.graph-mark')).toContainText('superseded')
    await expect(page.locator('#graph-keys')).toBeHidden()
    const canvas = page.locator('canvas.graph-canvas')
    await canvas.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('link', { name: 'Open page' })).toBeVisible()
    await expect(page.locator('#graph-keys')).toBeHidden()
    // The name of the chosen page is placed a frame after the inspector opens.
    await expect(page.locator('.graph-tip')).toBeVisible()
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const v = await page.evaluate(() => {
      const r = (q: string) => document.querySelector(q)?.getBoundingClientRect() ?? null
      const tip = r('.graph-tip')
      const over = [
        '.graph-communities',
        '.graph-inspector',
        '.graph-strip',
        '.graph-tools',
        '.graph-center',
      ].map((q) => [q, r(q)] as const)
      const hits = over
        .filter(([, b]) => b && tip && b.width > 0)
        .filter(([, b]) => {
          const t = tip as DOMRect
          const o = b as DOMRect
          return !(t.right <= o.left || t.left >= o.right || t.bottom <= o.top || t.top >= o.bottom)
        })
        .map(([q]) => q)
      const ring = getComputedStyle(document.querySelector('.graph-box') as Element, '::after')
      return {
        tipShown: Boolean(tip && tip.width > 0),
        hits,
        folded: !(document.querySelector('.graph-communities') as HTMLDetailsElement).open,
        ring: [ring.borderTopWidth, ring.borderRightWidth, ring.borderBottomWidth, ring.borderLeftWidth],
      }
    })
    expect(v.tipShown, 'the name of the chosen page is drawn').toBe(true)
    expect(v.hits, 'a panel lies over the name of the chosen page').toEqual([])
    expect(v.folded, 'the communities fold when the inspector opens').toBe(true)
    // The ring is drawn on all four sides of what is seen of the picture.
    expect(v.ring.every((w) => Number.parseFloat(w) >= 2)).toBe(true)
  })

test('the keys button opens the help over the picture and Escape closes it', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.goto(GRAPH)
  await settled(page)
  const button = page.getByRole('button', { name: 'Keys and gestures' })
  await button.click()
  await expect(page.locator('#graph-keys')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('#graph-keys')).toBeHidden()
})

test('Escape closes only the keys help when the inspector is open too', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.goto(GRAPH)
  await settled(page)
  await page.locator('canvas.graph-canvas').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('link', { name: 'Open page' })).toBeVisible()
  await page.getByRole('button', { name: 'Keys and gestures' }).click()
  await expect(page.locator('#graph-keys')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('#graph-keys')).toBeHidden()
  await expect(page.getByRole('link', { name: 'Open page' }), 'the inspector stays').toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('link', { name: 'Open page' })).toBeHidden()
})

test('an inspect address that names nothing opens no inspector and leaves the communities open', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.goto(`${GRAPH}?inspect=nonsense`)
  await settled(page)
  await expect(page.locator('.graph-inspector[data-open]')).toHaveCount(0)
  expect(await page.locator('.graph-communities').evaluate((d) => (d as HTMLDetailsElement).open)).toBe(true)
})

// How the picture reads, from its pixels: the ground is the commonest colour; the nodes are the commonest colour
// that stands at 3:1 or more against it; the links are the commonest colour between 1.05:1 and 1.5:1.
async function legibility(page: Page) {
  // Only the picture: every panel and control over it is hidden for the shot.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>(
      '.graph-communities,.graph-strip,.graph-over,.graph-center,.graph-tools,.graph-tip,.inspector-toggle',
    ))
      el.style.setProperty('visibility', 'hidden', 'important')
  })
  const shot = (await page.locator('canvas.graph-canvas').screenshot()).toString('base64')
  return page.evaluate(async (shot) => {
    const img = new Image()
    img.src = `data:image/png;base64,${shot}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d') as CanvasRenderingContext2D
    ctx.drawImage(img, 0, 0)
    // The middle of the picture only: the panels over its edges are not the picture.
    const d = ctx.getImageData(
      Math.floor(c.width * 0.3),
      Math.floor(c.height * 0.3),
      Math.floor(c.width * 0.3),
      Math.floor(c.height * 0.4),
    ).data
    const lum = (r: number, g: number, b: number) => {
      const f = (v: number) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const count = new Map<number, number>()
    for (let i = 0; i < d.length; i += 4) {
      const k = ((d[i] as number) << 16) | ((d[i + 1] as number) << 8) | (d[i + 2] as number)
      count.set(k, (count.get(k) ?? 0) + 1)
    }
    const colours = [...count.entries()].sort((a, b) => b[1] - a[1])
    const lumOf = (k: number) => lum((k >> 16) & 255, (k >> 8) & 255, k & 255)
    const ground = lumOf((colours[0] as [number, number])[0])
    const ratio = (k: number) => {
      const l = lumOf(k)
      return (Math.max(l, ground) + 0.05) / (Math.min(l, ground) + 0.05)
    }
    const nodes = colours.find(([k, n]) => n > 40 && ratio(k) >= 3)
    const links = colours.find(([k, n]) => n > 200 && ratio(k) >= 1.05 && ratio(k) < 1.5)
    const linkPixels = colours
      .filter(([k]) => ratio(k) >= 1.05 && ratio(k) < 1.5)
      .reduce((a, [, n]) => a + n, 0)
    return { nodes: nodes ? ratio(nodes[0]) : 0, links: links ? ratio(links[0]) : 0, linkPixels }
  }, shot)
}

for (const mode of ['light', 'dark', 'contrast'] as const)
  test(`the picture is legible in ${mode}: pages at 3:1 or more, links visible against the ground`, async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.addInitScript((m) => localStorage.setItem('rscb.theme', m), mode)
    await page.goto(GRAPH)
    await settled(page)
    const v = await legibility(page)
    expect(v.nodes, 'pages against the ground').toBeGreaterThanOrEqual(3)
    expect(v.links, 'links against the ground').toBeGreaterThanOrEqual(1.06)
    // Links are drawn: with their colour made equal to the ground, the same crop loses most of those pixels.
    const ground = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--raised').trim(),
    )
    await page.evaluate((g) => {
      document.documentElement.style.setProperty('--edge', g)
      // The picture repaints when the mode attribute is set (even to the same value).
      document.documentElement.setAttribute(
        'data-theme',
        document.documentElement.getAttribute('data-theme') ?? '',
      )
    }, ground)
    await page.waitForTimeout(600)
    const off = await legibility(page)
    expect(v.linkPixels, 'link pixels with the links drawn').toBeGreaterThan(off.linkPixels * 3)
    expect(v.linkPixels - off.linkPixels, 'link pixels the links add').toBeGreaterThan(500)
  })
