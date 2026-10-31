// Spec B6 CA5, CA6 and CA7 (PR22, T034), in Chromium with the CPU slowed down four times through CDP (plan
// §5.2: the bound CI keeps; the reference machine is measured locally). CA5: 300 pages are drawn within 3 s
// of opening (median of five loads). CA6: with 5 000 pages the graph comes by groups, three of them open one
// after the other, a page is focused and the list shown, and no task of the page lasts 200 ms or more.
// CA7: with reduced motion the worker sends one settled picture and nothing is drawn at rest.
import type { Page } from '@playwright/test'
import { expect, scenario, test } from './fixture.ts'

const GRAPH = '/b/growth/wiki/graph'
const settled = (page: Page) =>
  expect(page.locator('canvas.graph-canvas[data-settled]')).toHaveCount(1, { timeout: 60_000 })

// Long tasks of the page, from the start (buffered), kept where the test can read them.
const WATCH_LONG_TASKS = () => {
  const w = window as unknown as { __long: number[] }
  w.__long = []
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) w.__long.push(e.duration)
  }).observe({ type: 'longtask', buffered: true })
}
const longest = async (page: Page) =>
  page.evaluate(() => Math.max(0, ...((window as unknown as { __long: number[] }).__long ?? [])))

async function slowCpu(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
}

test.describe('the graph under load (CPU ×4)', () => {
  test.describe.configure({ timeout: 180_000 })

  test('CA5: 300 pages are drawn within 3 seconds; the list has all 300', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.addInitScript(WATCH_LONG_TASKS)
    await slowCpu(page)
    // The time to the settled picture (the layout done and painted), not to its first, unsettled frame.
    const times: number[] = []
    for (let i = 0; i < 5; i++) {
      await page.goto(GRAPH)
      await settled(page)
      times.push(
        await page.evaluate(() => performance.getEntriesByName('graph:settled')[0]?.startTime ?? Number.NaN),
      )
    }
    const median = [...times].sort((a, b) => a - b)[2] as number
    test.info().annotations.push({
      type: 'CA5 graph:settled ms (CPU ×4)',
      description: times.map(Math.round).join(', '),
    })
    expect(times.every(Number.isFinite)).toBe(true)
    expect(median).toBeLessThan(3000)
    test.info().annotations.push({ type: 'CA5 longest task ms', description: String(await longest(page)) })
    // The list: the pages drawn, and the retired ones on asking: all 300.
    await page.getByRole('button', { name: 'List' }).click()
    const caption = page.getByRole('table', { name: /Pages of the wiki/ }).getByRole('caption')
    await expect(caption).toContainText(/of (\d+) pages/)
    const drawn = Number(/of (\d+) pages/.exec((await caption.textContent()) ?? '')?.[1])
    const status = page.getByLabel('Status', { exact: true })
    if (!(await status.isVisible())) await page.getByText(/^Filters/).click()
    await status.selectOption('retired')
    await expect(caption).not.toContainText(`of ${drawn} pages`)
    const retired = Number(/of (\d+) pages?/.exec((await caption.textContent()) ?? '')?.[1])
    expect(drawn + retired).toBe(300)
  })

  test('CA6: 5 000 pages come by groups, open one by one, and no task blocks the page 200 ms', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 5000 })
    await page.addInitScript(WATCH_LONG_TASKS)
    await slowCpu(page)
    await page.goto(GRAPH)
    await expect(page.getByText(/so it is drawn by groups/)).toBeVisible({ timeout: 20_000 })
    await settled(page)
    const groups = await page.evaluate(async () => {
      const r = await fetch('/v1/brains/growth/wiki/graph')
      return ((await r.json()) as { groups: { prefix: string }[] }).groups.map((g) => g.prefix)
    })
    for (const prefix of groups.slice(0, 3)) {
      await page.getByRole('button', { name: 'List' }).click()
      await page.getByRole('button', { name: `Open group ${prefix}`, exact: true }).click()
      await page.getByRole('button', { name: 'Graph', exact: true }).click()
      await settled(page)
      await page.getByRole('button', { name: 'All groups' }).click()
      await settled(page)
    }
    // A page of a group, in focus; then the list.
    await page.getByRole('button', { name: 'List' }).click()
    await page
      .getByRole('button', { name: /^Focus: 1 hop, / })
      .first()
      .click()
    await expect(page.getByRole('table', { name: /and its neighbours$/ })).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: 'Graph', exact: true }).click()
    await settled(page)
    const max = await longest(page)
    test.info().annotations.push({ type: 'CA6 longest task ms (CPU ×4)', description: String(max) })
    expect(max).toBeLessThan(200)
  })
})

test('CA7: with reduced motion the graph is not animated', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await context.newPage()
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.goto(GRAPH)
  await settled(page)
  const canvas = page.locator('canvas.graph-canvas')
  // One picture from the worker, already settled.
  await expect(canvas).toHaveAttribute('data-frames', '1')
  const draws = Number(await canvas.getAttribute('data-draws'))
  // At rest nothing is drawn again.
  await page.waitForTimeout(1000)
  expect(Number(await canvas.getAttribute('data-draws'))).toBe(draws)
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
  await context.close()

  // Without it the picture moves as it settles: more than one.
  const moving = await browser.newContext({ reducedMotion: 'no-preference' })
  const p2 = await moving.newPage()
  await scenario(moving, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await p2.goto(GRAPH)
  await settled(p2)
  expect(Number(await p2.locator('canvas.graph-canvas').getAttribute('data-frames'))).toBeGreaterThan(1)
  await moving.close()
})
