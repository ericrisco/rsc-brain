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
