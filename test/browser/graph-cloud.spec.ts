// Spec amendment 2026-11-09, CA12 (plan canvas-ui S.1, SB4–SB6): the graph of a brain is a cloud of points in
// three dimensions. Each family (page type) has its colour and its pill; the brain's hub sits in the middle;
// the most linked pages are haloed. With motion allowed it turns slowly at rest, with a «yaw» readout, light
// travels its lines and a fact card shows one page after another; a touch stops it and it turns again after a
// rest. With reduced motion nothing moves. The pointer and the keys work on the picture as drawn.
import type { Page } from '@playwright/test'
import { expect, scenario, test } from './fixture.ts'

const GRAPH = '/b/growth/wiki/graph'
const settled = (page: Page) =>
  expect(page.locator('canvas.graph-canvas[data-settled]')).toHaveCount(1, { timeout: 30_000 })

test.describe('the cloud, still (reduced motion)', () => {
  test('SB4: each family has its pill, the hub sits in the middle, nothing moves', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto(GRAPH)
    await settled(page)
    const canvas = page.locator('canvas.graph-canvas')
    await expect(canvas).toHaveAttribute('data-families', /,/)
    const families = ((await canvas.getAttribute('data-families')) ?? '').split(',')
    // The seeded wiki has pages of several types: a pill for each type drawn, named as the legend names it.
    expect(families.length).toBeGreaterThanOrEqual(3)
    for (const f of families) expect(f).toMatch(/^[a-z]+$/)
    expect(new Set(families).size).toBe(families.length)
    // The hub inside the canvas, away from its edges.
    const box = (await canvas.boundingBox()) as { width: number; height: number }
    const [hx, hy] = ((await canvas.getAttribute('data-hub')) ?? '').split(',').map(Number) as [
      number,
      number,
    ]
    expect(hx).toBeGreaterThan(box.width * 0.2)
    expect(hx).toBeLessThan(box.width * 0.8)
    expect(hy).toBeGreaterThan(box.height * 0.15)
    expect(hy).toBeLessThan(box.height * 0.85)
    // Still: no turn, no light, no fact card, and nothing is drawn again at rest.
    await expect(canvas).toHaveAttribute('data-spinning', 'false')
    await expect(canvas).toHaveAttribute('data-pulses', '0')
    await expect(canvas).toHaveAttribute('data-fact', '-1')
    const yaw = await canvas.getAttribute('data-yaw')
    const draws = await canvas.getAttribute('data-draws')
    await page.waitForTimeout(1500)
    expect(await canvas.getAttribute('data-yaw')).toBe(yaw)
    expect(await canvas.getAttribute('data-draws')).toBe(draws)
  })

  test('SB4: a drag turns the cloud; a click then picks the page drawn under the pointer', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto(GRAPH)
    await settled(page)
    const canvas = page.locator('canvas.graph-canvas')
    const box = (await canvas.boundingBox()) as { x: number; y: number; width: number; height: number }
    const yaw = Number(await canvas.getAttribute('data-yaw'))
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 30, { steps: 6 })
    await page.mouse.up()
    await expect.poll(async () => Number(await canvas.getAttribute('data-yaw'))).not.toBe(yaw)
    // The keyboard's page, as drawn after the turn: a click there opens it.
    await canvas.focus()
    await expect(canvas).toHaveAttribute('data-active', /\d+,\d+/)
    const said =
      (await page
        .locator('[aria-live="polite"]')
        .filter({ hasText: /Enter to inspect/ })
        .textContent()) ?? ''
    const title = said.split('. ')[0] as string
    const card = await canvas.getAttribute('data-active-card')
    const [x, y, w, h] = card
      ? (card.split(',').map(Number) as [number, number, number, number])
      : [
          ...(((await canvas.getAttribute('data-active')) ?? '').split(',').map(Number) as [number, number]),
          0,
          0,
        ]
    await canvas.click({ position: { x: x + w / 2, y: y + h / 2 } })
    const inspector = page.getByRole('complementary', { name: /^Inspector \S/ })
    await expect(inspector.getByRole('heading', { level: 2 })).toHaveText(title)
  })
})
