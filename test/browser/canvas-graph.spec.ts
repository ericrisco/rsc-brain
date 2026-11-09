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
