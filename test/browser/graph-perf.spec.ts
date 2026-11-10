// Spec B6 CA5, CA6 and CA7 (PR22, T034), in Chromium with the page's CPU slowed down four times through CDP
// (plan §5.2: the bound CI keeps; the reference machine is measured locally). CDP cannot slow a worker, so CA5
// adds three times the worker's own time (laying out and painting) to what it measures. CA5: 300 pages are drawn within 3 s
// of opening (median of five loads). CA6: with 5 000 pages the graph comes by groups, three of them open one
// after the other, a page is focused and the list shown, and no task of the page lasts 200 ms or more.
// CA7: with reduced motion the worker sends one settled picture and nothing is drawn at rest. With motion
// allowed the layout is seen settling (more than one picture), and is still once at rest.
import { appendFileSync, mkdirSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, scenario, test } from './fixture.ts'

const GRAPH = '/b/growth/wiki/graph'

// Each measure is kept as a test note and in test-results/measures.txt, which verify.sh prints after the
// browser tests (its dot reporter prints no notes): the number CI measured can be read, not only that it
// passed.
function report(type: string, description: string) {
  test.info().annotations.push({ type, description })
  mkdirSync('test-results', { recursive: true })
  appendFileSync('test-results/measures.txt', `${type}: ${description}\n`)
}
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
  // With motion allowed: the layout is seen settling, and a page is dragged while it is measured (v0.5.0).
  test.use({ reducedMotion: 'no-preference' })

  test('CA5: 300 pages are drawn within 3 seconds; the list has all 300', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.addInitScript(WATCH_LONG_TASKS)
    await slowCpu(page)
    // The time to the settled picture (the layout done and painted), not to its first, unsettled frame. CDP
    // slows the page only ("Operation is only supported for pages, not workers"): the layout's worker runs at
    // full speed. So the bound is checked on an estimate that slows the worker too: the settled time plus three
    // times the worker's own working time (the time inside the layout's slices: what four times slower stretches).
    const times: number[] = []
    const worker: number[] = []
    // The painter's own time in the worker, every picture until the settled one (review A5): slowed four
    // times too in the estimate.
    const paint: number[] = []
    for (let i = 0; i < 5; i++) {
      await page.goto(GRAPH)
      await settled(page)
      times.push(
        await page.evaluate(() => performance.getEntriesByName('graph:settled')[0]?.startTime ?? Number.NaN),
      )
      worker.push(Number(await page.locator('canvas.graph-canvas').getAttribute('data-layout-ms')))
      paint.push(Number(await page.locator('canvas.graph-canvas').getAttribute('data-paint-ms')))
    }
    const estimate = times.map((t, i) => t + 3 * ((worker[i] as number) + (paint[i] as number)))
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[2] as number
    report('CA5 graph:settled ms (page CPU ×4, worker not slowed)', times.map(Math.round).join(', '))
    report('CA5 worker working ms (not slowed)', worker.join(', '))
    report('CA5 worker painting ms (not slowed)', paint.map(Math.round).join(', '))
    report('CA5 settled estimate ms (page and worker ×4)', estimate.map(Math.round).join(', '))
    expect(times.every(Number.isFinite)).toBe(true)
    expect(worker.every((x) => Number.isFinite(x) && x > 0)).toBe(true)
    expect(paint.every((x) => Number.isFinite(x) && x > 0)).toBe(true)
    expect(median(estimate)).toBeLessThan(3000)
    report('CA5 longest task ms (page CPU ×4)', String(await longest(page)))
    // A page dragged (v0.5.0): the layout moves under the pointer; each picture's painting time in the worker,
    // over two seconds of drag. Four times slower still paints 30 pictures a second, and the page is never
    // blocked 200 ms.
    const canvas = page.locator('canvas.graph-canvas')
    const all = await page.evaluate(() =>
      (
        window as unknown as { __graph: { items(): { x: number; y: number; role: number }[] } }
      ).__graph.items(),
    )
    const b = (await canvas.boundingBox()) as { x: number; y: number; width: number; height: number }
    const held = all.find(
      (it) => it.role === 0 && it.x > b.width * 0.25 && it.x < b.width * 0.5 && it.y > b.height * 0.3,
    ) as { x: number; y: number }
    await page.mouse.move(b.x + held.x, b.y + held.y)
    await page.mouse.down()
    const frameMs: number[] = []
    for (let k = 0; k < 8; k++) {
      await page.mouse.move(b.x + held.x + 20 * (k + 1), b.y + held.y + 10 * (k + 1), { steps: 4 })
      await page.waitForTimeout(250)
      frameMs.push(Number(await canvas.getAttribute('data-frame-ms')))
    }
    await page.mouse.up()
    const sorted = [...frameMs].sort((a, b) => a - b)
    const typical = sorted[Math.floor(sorted.length / 2)] as number
    report('CA5 dragging: worker ms a picture (not slowed)', frameMs.map((x) => x.toFixed(2)).join(', '))
    expect(frameMs.every((x) => Number.isFinite(x) && x > 0)).toBe(true)
    expect(4 * typical).toBeLessThan(1000 / 30)
    report('CA5 longest task ms while dragging (page CPU ×4)', String(await longest(page)))
    expect(await longest(page)).toBeLessThan(200)
    await expect(canvas).toHaveAttribute('data-moving', 'false', { timeout: 30_000 })
    // The list: the pages drawn, and the retired ones on asking: all 300. Read once the caption has its number.
    await page.getByRole('button', { name: 'List' }).click()
    const caption = page.getByRole('table', { name: /Pages of the wiki/ }).getByRole('caption')
    const count = async () =>
      Number(/of (\d+) pages?/.exec((await caption.textContent()) ?? '')?.[1] ?? Number.NaN)
    await expect.poll(count, { timeout: 30_000 }).toBeGreaterThan(0)
    const drawn = await count()
    const status = page.getByLabel('Status', { exact: true })
    if (!(await status.isVisible())) await page.locator('.graph-filters summary').click()
    await status.selectOption('retired')
    await expect
      .poll(
        async () => {
          const n = await count()
          return n > 0 && n !== drawn
        },
        { timeout: 30_000 },
      )
      .toBe(true)
    expect(drawn + (await count())).toBe(300)
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
    report('CA6 longest task ms (CPU ×4)', String(max))
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
