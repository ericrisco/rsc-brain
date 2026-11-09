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
