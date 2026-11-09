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

test.describe('the cloud, moving (motion allowed)', () => {
  test.use({ reducedMotion: 'no-preference', viewport: { width: 1920, height: 1080 } })
  const yawOf = async (page: Page) =>
    Number(await page.locator('canvas.graph-canvas').getAttribute('data-yaw'))

  test('SB5: at rest it turns slowly, its yaw counting up, and light travels its lines', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.goto(GRAPH)
    await settled(page)
    const canvas = page.locator('canvas.graph-canvas')
    await expect(canvas).toHaveAttribute('data-spinning', 'true')
    const a = await yawOf(page)
    await page.waitForTimeout(1500)
    const b = await yawOf(page)
    // About 7.2° a second (one turn in 50 s): more than a degree in 1.5 s, less than a quarter turn.
    const turned = (b - a + 360) % 360
    expect(turned).toBeGreaterThan(1)
    expect(turned).toBeLessThan(90)
    expect(Number(await canvas.getAttribute('data-pulses'))).toBeGreaterThan(0)
    // Turning, no names swim with it: the cards come back when it stops.
    await expect(canvas).toHaveAttribute('data-cards', '0')
  })

  test('SB5: the pointer stops it; it turns again after a rest; the keyboard stops it too', async ({
    page,
    context,
    baseURL,
  }) => {
    test.slow()
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.goto(GRAPH)
    await settled(page)
    const canvas = page.locator('canvas.graph-canvas')
    await expect(canvas).toHaveAttribute('data-spinning', 'true')
    const box = (await canvas.boundingBox()) as { x: number; y: number; width: number; height: number }
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3)
    await page.mouse.move(box.x + box.width * 0.31, box.y + box.height * 0.31)
    await expect(canvas).toHaveAttribute('data-spinning', 'false')
    const stopped = await yawOf(page)
    await page.waitForTimeout(1000)
    expect(await yawOf(page)).toBe(stopped)
    // Still, the light keeps travelling (names come only for what the pointer is on: canvas-graph.spec).
    expect(Number(await canvas.getAttribute('data-pulses'))).toBeGreaterThan(0)
    // The pointer leaves; after the rest (5 s) it turns again.
    await page.mouse.move(box.x + 2, box.y + box.height + 40)
    await expect(canvas).toHaveAttribute('data-spinning', 'true', { timeout: 9000 })
    // The keyboard on the canvas stops it while it is there.
    await canvas.focus()
    await expect(canvas).toHaveAttribute('data-spinning', 'false')
    const held = await yawOf(page)
    await page.waitForTimeout(6000)
    expect(await yawOf(page)).toBe(held)
  })

  test('SB5: a hidden tab stops the turn and the light', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.goto(GRAPH)
    await settled(page)
    const canvas = page.locator('canvas.graph-canvas')
    await expect(canvas).toHaveAttribute('data-spinning', 'true')
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect(canvas).toHaveAttribute('data-spinning', 'false')
    await expect(canvas).toHaveAttribute('data-pulses', '0')
    const draws = await canvas.getAttribute('data-draws')
    await page.waitForTimeout(1000)
    expect(await canvas.getAttribute('data-draws')).toBe(draws)
  })
})

test.describe('the legend and the fact card', () => {
  test('SB6: the legend gives each family drawn its shape, its colour, its name and how many', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto(GRAPH)
    await settled(page)
    const legend = page.getByRole('region', { name: 'Families' })
    await expect(legend).toBeVisible()
    const rows = await legend.getByRole('listitem').evaluateAll((lis) =>
      lis.map((li) => {
        const probe = document.createElement('span')
        probe.style.cssText = 'color: var(--panel-c)'
        li.append(probe)
        const colour = getComputedStyle(probe).color
        probe.remove()
        const shape = li.querySelector('svg path') as SVGPathElement
        return {
          name: li.querySelector('.fam-name')?.textContent ?? '',
          count: Number(li.querySelector('.fam-count')?.textContent),
          colour,
          shape: shape ? getComputedStyle(shape).fill : '',
          countInk: getComputedStyle(li.querySelector('.fam-count') as Element).color,
          d: shape?.getAttribute('d') ?? '',
        }
      }),
    )
    expect(rows.length).toBeGreaterThanOrEqual(3)
    // Every page drawn is counted once.
    const items = Number(await page.locator('canvas.graph-canvas').getAttribute('data-items'))
    expect(rows.reduce((t, r) => t + r.count, 0)).toBe(items)
    // Biggest first; each family its own colour and its own shape (colour is never the only sign).
    expect(rows.map((r) => r.count)).toEqual([...rows.map((r) => r.count)].sort((a, b) => b - a))
    expect(new Set(rows.map((r) => r.colour)).size).toBe(rows.length)
    expect(new Set(rows.map((r) => r.d)).size).toBe(rows.length)
    for (const r of rows) {
      expect(r.shape).toBe(r.colour)
      expect(r.countInk).toBe(r.colour)
    }
    // The pills on the canvas name the same families.
    const pills = ((await page.locator('canvas.graph-canvas').getAttribute('data-families')) ?? '').split(',')
    expect([...pills].sort()).toEqual(rows.map((r) => r.name.toLowerCase()).sort())
    // A filter by type leaves one family, with the pages it draws.
    await page.locator('.graph-filters summary').click()
    await page.getByLabel('Type', { exact: true }).selectOption('decision')
    await expect(legend.getByRole('listitem')).toHaveCount(1)
    await expect(legend.getByRole('listitem')).toContainText('Decisions')
  })

  test.describe('moving', () => {
    test.use({ reducedMotion: 'no-preference' })
    test('SB6: while it turns a fact card shows one page after another, with where it lives and when', async ({
      page,
      context,
      baseURL,
    }) => {
      await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
      await page.setViewportSize({ width: 1920, height: 1080 })
      await page.goto(GRAPH)
      await settled(page)
      const canvas = page.locator('canvas.graph-canvas')
      await expect
        .poll(async () => Number(await canvas.getAttribute('data-fact')), { timeout: 8000 })
        .toBeGreaterThanOrEqual(0)
      const first = await canvas.getAttribute('data-fact-card')
      // Its title, then the page's address and the day it last changed.
      expect(first).toMatch(/^.+ — [\w/-]+ · \d{1,2} \w{3} \d{4}$/)
      await expect.poll(() => canvas.getAttribute('data-fact-card'), { timeout: 8000 }).not.toBe(first)
    })
  })
})
