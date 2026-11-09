// Spec canvas-ui CA8 and CA9 (plan B.3, B12–B17): the graph of a brain is a canvas that fills the space
// right of the rail, edge to edge and the full height of the window, with nothing to scroll; the list stays
// a page.
import type { Page } from '@playwright/test'
import { expect, scenario, test } from './fixture.ts'

const GRAPH = '/b/growth/wiki/graph'
const settled = (page: Page) =>
  expect(page.locator('canvas.graph-canvas[data-settled]')).toHaveCount(1, { timeout: 20_000 })

const box = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
  })

for (const size of [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
])
  test(`CA8 at ${size.width}×${size.height}: the canvas fills the space right of the rail, edge to edge`, async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.setViewportSize(size)
    await page.goto(GRAPH)
    await settled(page)
    const rail = await box(page, 'header.rail')
    const canvas = await box(page, 'canvas.graph-canvas')
    // From the rail's edge (its line belongs to the screen) to the window's right edge, top to bottom.
    expect(Math.abs(canvas.left - rail.right), 'left edge').toBeLessThanOrEqual(1)
    expect(Math.abs(canvas.right - size.width), 'right edge').toBeLessThanOrEqual(1)
    expect(Math.abs(canvas.top), 'top edge').toBeLessThanOrEqual(1)
    expect(Math.abs(canvas.bottom - size.height), 'bottom edge').toBeLessThanOrEqual(1)
    // Nothing to scroll: the canvas is the screen.
    const scroll = await page.evaluate(() => ({
      y: document.scrollingElement?.scrollHeight ?? 0,
      x: document.scrollingElement?.scrollWidth ?? 0,
    }))
    expect(scroll.y).toBeLessThanOrEqual(size.height)
    expect(scroll.x).toBeLessThanOrEqual(size.width)
    await expect(page.locator('.frame')).toHaveAttribute('data-mode', 'canvas')
  })

test('the list is a page: it scrolls, and the frame is not in canvas mode', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.goto(`${GRAPH}?view=list`)
  await expect(page.getByRole('table', { name: /Pages of the wiki/ }).locator('tbody tr')).toHaveCount(50)
  await expect(page.locator('.frame')).not.toHaveAttribute('data-mode', 'canvas')
  expect(await page.evaluate(() => document.scrollingElement?.scrollHeight ?? 0)).toBeGreaterThan(768)
  // Back to the graph by its button: the frame becomes a canvas again.
  await page.getByRole('button', { name: 'Graph', exact: true }).click()
  await settled(page)
  await expect(page.locator('.frame')).toHaveAttribute('data-mode', 'canvas')
})

// D6–D8: zoomed in, pages are readable cards; the ground is dotted; a click on a card, even at its edge,
// picks its page.
test('CA8: the pages are cards on a dotted ground; a click at the edge of a card opens it', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(GRAPH)
  await settled(page)
  const canvas = page.locator('canvas.graph-canvas')
  await expect.poll(async () => Number(await canvas.getAttribute('data-cards'))).toBeGreaterThan(0)
  await expect.poll(async () => Number(await canvas.getAttribute('data-dots'))).toBeGreaterThanOrEqual(6)
  // The keyboard's page always has its card.
  await canvas.focus()
  await page.keyboard.press('ArrowRight')
  await expect(canvas).toHaveAttribute('data-active-card', /^-?\d+,-?\d+,\d+,\d+$/)
  const said =
    (await page
      .locator('[aria-live="polite"]')
      .filter({ hasText: /Enter to inspect/ })
      .textContent()) ?? ''
  const title = said.split('. ')[0] as string
  const [x, y, w, h] = ((await canvas.getAttribute('data-active-card')) ?? '').split(',').map(Number) as [
    number,
    number,
    number,
    number,
  ]
  expect(h).toBe(28)
  // Two pixels inside its right edge: far from the page's point, still its card.
  await canvas.click({ position: { x: x + w - 2, y: y + h / 2 } })
  const inspector = page.getByRole('complementary', { name: /^Inspector \S/ })
  await expect(inspector.getByRole('heading', { level: 2 })).toHaveText(title)
})

// B15: the controls sit at the canvas's edges: its name and where you are at the top left, Graph | List at
// the top in the middle with the filters beside it (opening them moves nothing), the zoom tools at the bottom
// left with their names and keys, the legend at the bottom right.
test('CA8: the canvas controls at its edges; the filters open over the picture without moving it', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(GRAPH)
  await settled(page)
  const canvas = await box(page, 'canvas.graph-canvas')
  const mid = (canvas.left + canvas.right) / 2
  const title = await box(page, 'h1')
  expect(title.left - canvas.left).toBeLessThan(48)
  expect(title.top - canvas.top).toBeLessThan(48)
  const views = await box(page, '.graph-views')
  expect(Math.abs((views.left + views.right) / 2 - mid), 'Graph | List in the middle').toBeLessThan(160)
  expect(views.top - canvas.top).toBeLessThan(32)
  const tools = page.locator('.graph-tools')
  for (const [name, key] of [
    ['Fit', '0'],
    ['Zoom in', '+'],
    ['Zoom out', '-'],
  ] as const) {
    const b = tools.getByRole('button', { name, exact: true })
    await expect(b).toHaveAttribute('aria-keyshortcuts', key)
    const r = (await b.boundingBox()) as { width: number; height: number }
    expect(Math.min(r.width, r.height)).toBeGreaterThanOrEqual(24)
  }
  const t = await box(page, '.graph-tools')
  expect(t.left - canvas.left).toBeLessThan(32)
  expect(canvas.bottom - t.bottom).toBeLessThan(32)
  const legend = await box(page, '.graph-legend')
  expect(canvas.right - legend.right).toBeLessThan(32)
  expect(canvas.bottom - legend.bottom).toBeLessThan(32)
  // The filters: a panel over the picture.
  await page.locator('.graph-filters summary').click()
  await expect(page.getByLabel('Words', { exact: true })).toBeVisible()
  expect(await box(page, 'canvas.graph-canvas')).toEqual(canvas)
  const panel = await box(page, '.graph-filters search')
  expect(panel.top).toBeGreaterThan(views.top)
})

test('loading: the canvas shows its dotted ground and grey cards', async ({ page, context, baseURL }) => {
  const s = await scenario(context, baseURL as string, 'signed-in')
  await s.state('graph', 'loading')
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.goto(GRAPH)
  const loading = page.locator('.graph-box.loading')
  await expect(loading).toBeVisible()
  await expect(loading.locator('.skeleton-card')).not.toHaveCount(0)
  const ground = await loading.evaluate((el) => getComputedStyle(el).backgroundImage)
  expect(ground).toContain('radial-gradient')
  const b = await box(page, '.graph-box.loading')
  expect(b.bottom).toBeGreaterThanOrEqual(767)
})

// D9 (B16): the inspector is a panel over the right of the canvas that folds away. Opening it resizes
// nothing and does not move the picture; Fit then fits the picture in what it leaves; a page picked opens
// it; Escape clears the page and folds it.
test('CA8: the inspector folds and unfolds at the right without moving the picture; Fit leaves it free', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(GRAPH)
  await settled(page)
  const canvas = page.locator('canvas.graph-canvas')
  const toggle = page.getByRole('button', { name: 'Inspector', exact: true })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('#graph-inspector')).toBeHidden()
  await canvas.focus()
  await expect(canvas).toHaveAttribute('data-active', /\d+,\d+/)
  const before = await canvas.getAttribute('data-active')
  const size = await box(page, 'canvas.graph-canvas')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const panel = page.locator('#graph-inspector')
  await expect(panel).toBeVisible()
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  expect(await box(page, 'canvas.graph-canvas'), 'the canvas keeps its size').toEqual(size)
  expect(await canvas.getAttribute('data-active'), 'the picture has not moved').toBe(before)
  // Fit: the page under the keyboard is drawn left of the panel.
  await page.getByRole('button', { name: 'Fit', exact: true }).click()
  const p = await box(page, '#graph-inspector')
  await expect
    .poll(async () => Number(((await canvas.getAttribute('data-active')) ?? '').split(',')[0]))
    .toBeLessThan(p.left - size.left)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(panel).toBeHidden()
  // A page picked unfolds it; Escape folds it again.
  await canvas.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('complementary', { name: /^Inspector \S/ })).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
})

// CA9: by keyboard alone the canvas is reached, its pages walked, one opened in the panel and closed.
test('CA9: the canvas by keyboard: Tab to it, arrows walk the pages, Enter opens, Escape closes', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(GRAPH)
  await settled(page)
  const canvas = page.getByRole('application', { name: /^Graph of \d+ items$/ })
  // The zoom tools come just before it: Tab from the last one reaches the canvas.
  await page.getByRole('button', { name: 'Zoom out', exact: true }).focus()
  await page.keyboard.press('Tab')
  await expect(canvas).toBeFocused()
  const said = page.locator('[aria-live="polite"]').filter({ hasText: /Enter to inspect/ })
  await expect(said).toHaveCount(1)
  const first = await canvas.getAttribute('data-active')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => canvas.getAttribute('data-active')).not.toBe(first)
  await page.keyboard.press('Enter')
  const inspector = page.getByRole('complementary', { name: /^Inspector \S/ })
  await expect(inspector).toBeVisible()
  await expect(canvas).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(inspector).toHaveCount(0)
})

// CA9: the page picked and the page under the keyboard are told apart by shape: a ring outside the
// keyboard's card, none outside the picked one.
test('CA9: picked and under the keyboard differ by shape, not by colour alone', async ({
  page,
  context,
  baseURL,
}) => {
  // A small wiki: few lines cross the strips read above the cards.
  await scenario(context, baseURL as string, 'signed-in')
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(GRAPH)
  await settled(page)
  const canvas = page.locator('canvas.graph-canvas')
  await canvas.focus()
  await page.keyboard.press('Enter')
  await expect(canvas).toHaveAttribute('data-selected-card', /\d+,\d+,\d+,\d+/)
  const picked = await canvas.getAttribute('data-selected-card')
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => canvas.getAttribute('data-active-card')).not.toBe(picked)
  await expect(canvas).toHaveAttribute('data-active-card', /\d+,\d+,\d+,\d+/)
  const rect = async (name: string) =>
    ((await canvas.getAttribute(name)) ?? '').split(',').map(Number) as [number, number, number, number]
  const c = await box(page, 'canvas.graph-canvas')
  // Along the straight top of a card, in a strip 2–5 px above it: the share of columns where something other
  // than the ground and its dots is drawn (a ring fills them all; a line crossing fills a few).
  const ringAt = async ([x, y, w]: [number, number, number, number]) => {
    const shot = await page.screenshot({
      clip: { x: c.left + x + 20, y: c.top + y - 5, width: w - 40, height: 3 },
    })
    return page.evaluate(async (b64) => {
      const css = getComputedStyle(document.documentElement)
      const sw = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D
      const rgb = (v: string) => {
        sw.clearRect(0, 0, 1, 1)
        sw.fillStyle = css.getPropertyValue(v).trim()
        sw.fillRect(0, 0, 1, 1)
        return [...sw.getImageData(0, 0, 1, 1).data].slice(0, 3)
      }
      const grounds = [rgb('--ground'), rgb('--grid-dot')]
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const k = document.createElement('canvas')
      k.width = img.width
      k.height = img.height
      const x = k.getContext('2d') as CanvasRenderingContext2D
      x.drawImage(img, 0, 0)
      const d = x.getImageData(0, 0, k.width, k.height).data
      const inked = new Set<number>()
      for (let i = 0; i < d.length; i += 4)
        if (
          grounds.every(
            (g) =>
              Math.abs((d[i] as number) - (g[0] as number)) +
                Math.abs((d[i + 1] as number) - (g[1] as number)) +
                Math.abs((d[i + 2] as number) - (g[2] as number)) >
              40,
          )
        )
          inked.add((i / 4) % k.width)
      return inked.size / k.width
    }, shot.toString('base64'))
  }
  const active = await rect('data-active-card')
  const selected = await rect('data-selected-card')
  expect(await ringAt(active), 'a ring outside the keyboard’s card').toBeGreaterThan(0.9)
  expect(await ringAt(selected), 'no ring outside the picked card').toBeLessThan(0.5)
})

// CA9: with reduced motion nothing on the canvas screen animates, the rail and panel included.
test('CA9: with reduced motion nothing moves on the canvas screen', async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.goto(GRAPH)
  await settled(page)
  await page.getByRole('button', { name: 'Expand the side bar' }).click()
  await page.getByRole('button', { name: 'Inspector', exact: true }).click()
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
  const t = await page
    .locator('.frame')
    .evaluate((el) => [
      getComputedStyle(el).transitionDuration,
      getComputedStyle(el.querySelector('.rail') as Element).transitionDuration,
    ])
  for (const d of t) expect(d.split(',').every((x) => Number.parseFloat(x) === 0)).toBe(true)
  await context.close()
})
