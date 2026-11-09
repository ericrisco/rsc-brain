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

// Review R9: the painter writes in the interface's face. Its worker has no stylesheet: it loads the same
// self-hosted JetBrains Mono itself and says so once the face is in.
test('R9: the canvas writes its names in JetBrains Mono', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.goto(GRAPH)
  await settled(page)
  await expect(page.locator('canvas.graph-canvas')).toHaveAttribute('data-font', 'JetBrains Mono')
})

// The strip's words never run under Graph | List | Filters or the panel's switch, panel open or closed.
for (const width of [1100, 1366, 1920])
  test(`the strip's words stay clear of the controls in it at ${width}`, async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.setViewportSize({ width, height: 900 })
    await page.goto(GRAPH)
    await settled(page)
    const boxOf = (q: string) =>
      page.locator(q).evaluate((el) => {
        const r = el.getBoundingClientRect()
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, shown: r.width > 0 }
      })
    for (const open of [false, true]) {
      if (open) await page.getByRole('button', { name: 'Inspector', exact: true }).click()
      const controls = [await boxOf('.graph-center'), await boxOf('.inspector-toggle')]
      for (const q of ['.graph-strip .panel-about', '.graph-strip .panel-meta', '.graph-strip h1']) {
        const w = await boxOf(q)
        if (!w.shown) continue
        for (const c of controls)
          expect(w.right <= c.left || w.left >= c.right, `${q} under a control, panel ${open}`).toBe(true)
      }
    }
  })

// Review R2: after a filter the cloud is framed on what is left, so every point moves on screen. The pointer
// finds points on the page's copy of the projection; that copy must be the one the painter drew with, or a click
// on a bare point picks the page drawn there before. data-active is where the painter drew the keyboard's page;
// data-active-here is where the page's copy puts it.
const sameProjection = async (page: Page) => {
  const canvas = page.locator('canvas.graph-canvas')
  await canvas.focus()
  await expect(canvas).toHaveAttribute('data-active', /\d+,\d+/)
  await expect
    .poll(async () => {
      const a = ((await canvas.getAttribute('data-active')) ?? '').split(',').map(Number)
      const b = ((await canvas.getAttribute('data-active-here')) ?? '').split(',').map(Number)
      return (
        b.length === 2 && Math.abs((a[0] ?? 0) - (b[0] ?? 0)) <= 1 && Math.abs((a[1] ?? 0) - (b[1] ?? 0)) <= 1
      )
    })
    .toBe(true)
}

test.describe('R2: a filter moves every point; the pointer follows', () => {
  for (const motion of ['reduce', 'no-preference'] as const)
    test(`the page hit-tests the projection the painter drew after a filter (${motion})`, async ({
      page,
      context,
      baseURL,
    }) => {
      await page.emulateMedia({ reducedMotion: motion })
      await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
      await page.setViewportSize({ width: 1920, height: 1080 })
      await page.goto(GRAPH)
      await settled(page)
      await page.locator('.graph-filters summary').click()
      await page.locator('#graph-type').selectOption('entity')
      await page.locator('.graph-filters summary').click()
      await settled(page)
      await sameProjection(page)
    })
})

// Review R6: the pages without links lie in rows under the cloud with their caption, and stay there as it turns.
test('R6: the pages without links keep their caption under the cloud at any yaw', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 'loose' })
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(GRAPH)
  await settled(page)
  const canvas = page.locator('canvas.graph-canvas')
  await expect(canvas).toHaveAttribute('data-orphans', /^\d+,\d+$/)
  const at = async () =>
    ((await canvas.getAttribute('data-orphans')) ?? '').split(',').map(Number) as [number, number]
  const hub = async () =>
    ((await canvas.getAttribute('data-hub')) ?? '').split(',').map(Number) as [number, number]
  const [, y0] = await at()
  expect(y0).toBeGreaterThan((await hub())[1])
  // A drag turns the cloud; the rows and their caption stay under it.
  const box = (await canvas.boundingBox()) as { x: number; y: number; width: number; height: number }
  const yaw = await canvas.getAttribute('data-yaw')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 3, { steps: 6 })
  await page.mouse.up()
  await expect(canvas).not.toHaveAttribute('data-yaw', yaw ?? '')
  await expect.poll(async () => (await at())[1] > (await hub())[1]).toBe(true)
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

  // Review R3: what the pointer finds is what is drawn now, not where the cloud stood before it turned.
  test('R3: a click on a turning cloud picks only what is drawn there once it stops', async ({
    page,
    context,
    baseURL,
  }) => {
    test.slow()
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.goto(GRAPH)
    await settled(page)
    const canvas = page.locator('canvas.graph-canvas')
    // Still under the keyboard: where its page is drawn now.
    await canvas.focus()
    await expect(canvas).toHaveAttribute('data-spinning', 'false')
    await expect(canvas).toHaveAttribute('data-active', /\d+,\d+/)
    const [x, y] = ((await canvas.getAttribute('data-active')) ?? '').split(',').map(Number) as [
      number,
      number,
    ]
    // Away from the canvas it turns again, far enough for that page to be somewhere else.
    await page.locator('.graph-strip h1').click()
    await page.mouse.move(2, 2)
    await expect(canvas).toHaveAttribute('data-spinning', 'true', { timeout: 9000 })
    const from = await yawOf(page)
    await expect
      .poll(async () => ((await yawOf(page)) - from + 360) % 360, { timeout: 9000 })
      .toBeGreaterThan(25)
    // A click on that old spot: whatever it picks has its card drawn there.
    await canvas.click({ position: { x, y } })
    await expect
      .poll(() =>
        canvas.evaluate((c) => (c as HTMLElement).dataset.drawnSeq === (c as HTMLElement).dataset.sentSeq),
      )
      .toBe(true)
    await page.waitForTimeout(300)
    // Picked: the page is drawn under the pointer (its point near, or its card over the spot).
    const inspector = page.getByRole('complementary', { name: /^Inspector \S/ })
    if ((await inspector.count()) === 0) return
    const [ax, ay] = ((await canvas.getAttribute('data-active')) ?? '').split(',').map(Number) as [
      number,
      number,
    ]
    const card = await canvas.getAttribute('data-selected-card')
    const [cx, cy, cw, ch] = (card ?? '0,0,0,0').split(',').map(Number) as [number, number, number, number]
    const onCard = x >= cx && x <= cx + cw && y >= cy && y <= cy + ch
    expect(onCard || Math.hypot(ax - x, ay - y) <= 24).toBe(true)
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

  // Review R7: out of sight (scrolled away, covered), nothing is painted.
  test('R7: a canvas out of sight stops turning and painting', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.goto(GRAPH)
    await settled(page)
    const canvas = page.locator('canvas.graph-canvas')
    await expect(canvas).toHaveAttribute('data-spinning', 'true')
    await canvas.evaluate((c) => {
      ;(c as HTMLElement).style.transform = 'translateY(4000px)'
    })
    await expect(canvas).toHaveAttribute('data-spinning', 'false')
    const draws = await canvas.getAttribute('data-draws')
    await page.waitForTimeout(1000)
    expect(await canvas.getAttribute('data-draws')).toBe(draws)
    // Back in sight, it moves again.
    await canvas.evaluate((c) => {
      ;(c as HTMLElement).style.transform = ''
    })
    await expect(canvas).toHaveAttribute('data-spinning', 'true')
  })

  // Review R11: the system asking for less motion, or the theme changed, take effect at once.
  test('R11: reduced motion asked while it turns stops it; a theme change repaints', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.goto(GRAPH)
    await settled(page)
    const canvas = page.locator('canvas.graph-canvas')
    await expect(canvas).toHaveAttribute('data-spinning', 'true')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(canvas).toHaveAttribute('data-spinning', 'false')
    await expect(canvas).toHaveAttribute('data-pulses', '0')
    const draws = Number(await canvas.getAttribute('data-draws'))
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light'
    })
    await expect.poll(async () => Number(await canvas.getAttribute('data-draws'))).toBeGreaterThan(draws)
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

// Polish (2026-11-09): the canvas is framed like the reference's first panel: coloured corners, and a strip
// with the numbered chip, «GRAPH · <brain> · what your agents know» and «<N> PAGES · <M> LINKS» in the panel's
// colour. Graph | List | Filters and the Inspector switch sit in that strip and work as before. One legend,
// the panel at the top left, folded from its own header.
test('the canvas is a panel with its strip; one legend that folds from its header', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(GRAPH)
  await settled(page)
  const screen = page.locator('.graph-screen')
  await expect(screen).toHaveClass(/\bpanel\b/)
  const corners = await screen.evaluate(
    (el) => getComputedStyle(el, '::before').backgroundImage.split('linear-gradient').length - 1,
  )
  expect(corners).toBe(8)
  const strip = page.locator('.graph-strip')
  await expect(strip.locator('.panel-num')).toHaveText('01')
  await expect(strip.getByRole('heading', { level: 1 })).toHaveText('Graph')
  await expect(strip).toContainText('Growth')
  await expect(strip).toContainText('what your agents know')
  const items = Number(await page.locator('canvas.graph-canvas').getAttribute('data-items'))
  await expect(strip.locator('.panel-meta')).toHaveText(new RegExp(`^${items} pages · [\\d,]+ links$`))
  // The strip runs along the top of the canvas; the controls sit in it.
  const s = (await strip.boundingBox()) as { x: number; y: number; width: number; height: number }
  const c = (await page.locator('canvas.graph-canvas').boundingBox()) as {
    x: number
    y: number
    width: number
  }
  expect(Math.abs(s.y - c.y)).toBeLessThanOrEqual(1)
  expect(s.width).toBeGreaterThan(c.width - 2)
  for (const q of ['.graph-views', '.inspector-toggle']) {
    const b = (await page.locator(q).boundingBox()) as { y: number; height: number }
    expect(b.y).toBeGreaterThanOrEqual(s.y)
    expect(b.y + b.height).toBeLessThanOrEqual(s.y + s.height + 1)
  }
  await page.getByRole('button', { name: 'List', exact: true }).click()
  await expect(page.getByRole('table', { name: /Pages of the wiki/ })).toBeVisible()
  await page.getByRole('button', { name: 'Graph', exact: true }).click()
  await settled(page)
  // One legend: the panel at the top left, with the families and the kinds of lines, folding from its header.
  await expect(page.locator('.graph-legend')).toHaveCount(1)
  const legend = page.locator('.graph-legend')
  await expect(legend.getByRole('region', { name: 'Families' })).toBeVisible()
  await expect(legend).toContainText('Link kinds')
  await legend.locator('summary.legend-head').click()
  await expect(legend.getByRole('region', { name: 'Families' })).toBeHidden()
  await legend.locator('summary.legend-head').click()
  await expect(legend.getByRole('region', { name: 'Families' })).toBeVisible()
})

// Review R5: on a touch screen one finger turns the cloud at Fit only; zoomed past Fit it moves the picture,
// and two fingers move and pinch it at any zoom.
test.describe('the cloud by touch', () => {
  test.use({ hasTouch: true, viewport: { width: 1366, height: 900 } })
  type Finger = { x: number; y: number; id: number }
  const hubOf = async (page: Page) =>
    ((await page.locator('canvas.graph-canvas').getAttribute('data-hub')) ?? '').split(',').map(Number) as [
      number,
      number,
    ]
  const fingers = async (page: Page, from: Finger[], to: Finger[]) => {
    const cdp = await page.context().newCDPSession(page)
    const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: Finger[]) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id })),
      })
    await send('touchStart', from)
    for (let k = 1; k <= 8; k++)
      await send(
        'touchMove',
        from.map((p, n) => {
          const q = to[n] as Finger
          return { id: p.id, x: p.x + ((q.x - p.x) * k) / 8, y: p.y + ((q.y - p.y) * k) / 8 }
        }),
      )
    await send('touchEnd', [])
    await cdp.detach()
  }
  const upToDate = (page: Page) =>
    expect
      .poll(() =>
        page
          .locator('canvas.graph-canvas')
          .evaluate((c) => (c as HTMLElement).dataset.drawnSeq === (c as HTMLElement).dataset.sentSeq),
      )
      .toBe(true)

  test('R5: one finger turns at Fit, moves the picture past Fit; two fingers move and pinch it', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.goto(GRAPH)
    await settled(page)
    const canvas = page.locator('canvas.graph-canvas')
    const b = (await canvas.boundingBox()) as { x: number; y: number; width: number; height: number }
    const mx = b.x + b.width * 0.45
    const my = b.y + b.height * 0.55
    // At Fit: one finger turns.
    const yaw0 = await canvas.getAttribute('data-yaw')
    await fingers(page, [{ x: mx, y: my, id: 1 }], [{ x: mx + 120, y: my, id: 1 }])
    await upToDate(page)
    expect(await canvas.getAttribute('data-yaw')).not.toBe(yaw0)
    // Zoomed a little past Fit (cards not yet tiles): one finger moves the picture, the cloud does not turn.
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await upToDate(page)
    const yaw1 = await canvas.getAttribute('data-yaw')
    const hub1 = await hubOf(page)
    await fingers(page, [{ x: mx, y: my, id: 1 }], [{ x: mx + 100, y: my + 40, id: 1 }])
    await upToDate(page)
    expect(await canvas.getAttribute('data-yaw')).toBe(yaw1)
    const hub2 = await hubOf(page)
    expect(Math.abs(hub2[0] - hub1[0] - 100)).toBeLessThanOrEqual(6)
    expect(Math.abs(hub2[1] - hub1[1] - 40)).toBeLessThanOrEqual(6)
    // Two fingers spread apart around a spot: the picture grows around it, by as much (a fifth).
    const cx = mx - b.x
    const cy = my - b.y
    await fingers(
      page,
      [
        { x: mx - 100, y: my, id: 1 },
        { x: mx + 100, y: my, id: 2 },
      ],
      [
        { x: mx - 120, y: my, id: 1 },
        { x: mx + 120, y: my, id: 2 },
      ],
    )
    await upToDate(page)
    expect(await canvas.getAttribute('data-yaw')).toBe(yaw1)
    const hub3 = await hubOf(page)
    expect(Math.abs(hub3[0] - (cx + 1.2 * (hub2[0] - cx)))).toBeLessThanOrEqual(8)
    expect(Math.abs(hub3[1] - (cy + 1.2 * (hub2[1] - cy)))).toBeLessThanOrEqual(8)
    // Two fingers moved together move the picture by as much.
    await fingers(
      page,
      [
        { x: mx - 60, y: my, id: 1 },
        { x: mx + 60, y: my, id: 2 },
      ],
      [
        { x: mx - 10, y: my - 30, id: 1 },
        { x: mx + 110, y: my - 30, id: 2 },
      ],
    )
    await upToDate(page)
    const hub4 = await hubOf(page)
    expect(Math.abs(hub4[0] - hub3[0] - 50)).toBeLessThanOrEqual(6)
    expect(Math.abs(hub4[1] - hub3[1] + 30)).toBeLessThanOrEqual(6)
  })
})
