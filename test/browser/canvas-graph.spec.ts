// Spec canvas-ui CA8 and CA9 (plan B.3, B12–B17): the graph of a brain is a canvas that fills the space
// right of the rail, edge to edge and the full height of the window, with nothing to scroll; the list stays
// a page.
import type { Page } from '@playwright/test'
import { expect, scenario, test } from './fixture.ts'

const GRAPH = '/b/growth/wiki/graph'
const settled = (page: Page) =>
  expect(page.locator('canvas.graph-canvas[data-settled]')).toHaveCount(1, { timeout: 20_000 })

// The picture shows the last state the page sent its painter (State.seq echoed back as data-drawn-seq).
const upToDate = (page: Page) =>
  expect
    .poll(() =>
      page
        .locator('canvas.graph-canvas')
        .evaluate((c) => (c as HTMLElement).dataset.drawnSeq === (c as HTMLElement).dataset.sentSeq),
    )
    .toBe(true)

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
  // The one legend (polish 2026-11-09): at the top left, under the name, clear of the zoom tools.
  const legend = await box(page, '.graph-legend')
  expect(legend.left - canvas.left).toBeLessThan(32)
  expect(legend.top).toBeGreaterThan(title.bottom)
  expect(legend.bottom).toBeLessThan(t.top)
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
  // Read the place once the picture shows the last state sent; open the panel, and read it again once the
  // picture shows the state that opening sent (review A3, R2-3: no fixed wait, no picture still on its way).
  await upToDate(page)
  const before = await canvas.getAttribute('data-active')
  const sent = Number(await canvas.getAttribute('data-sent-seq'))
  const size = await box(page, 'canvas.graph-canvas')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const panel = page.locator('#graph-inspector')
  await expect(panel).toBeVisible()
  await expect.poll(async () => Number(await canvas.getAttribute('data-sent-seq'))).toBeGreaterThan(sent)
  await upToDate(page)
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
  // Each arrow moves the keyboard to another page (in the cloud drawn in depth, Right then Down may come
  // back to where it started: each step is checked on its own). The start is read once it is drawn.
  await expect(canvas).toHaveAttribute('data-active', /\d+,\d+/)
  const first = await canvas.getAttribute('data-active')
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => canvas.getAttribute('data-active')).not.toBe(first)
  const second = await canvas.getAttribute('data-active')
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => canvas.getAttribute('data-active')).not.toBe(second)
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

// A brain just started (two pages): Fit zooms in until its pages read as tiles, as tall as the nodes of a
// flow editor, with their whole titles.
test('CA8: a two-page brain fits as big tiles with whole titles', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 'small' })
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(GRAPH)
  await settled(page)
  const canvas = page.locator('canvas.graph-canvas')
  await expect(canvas).toHaveAttribute('data-cards', '2')
  const tiles = JSON.parse((await canvas.getAttribute('data-card-list')) ?? '[]') as {
    h: number
    w: number
    title: string
  }[]
  expect(tiles).toHaveLength(2)
  for (const t of tiles) {
    expect(t.h, 'a tile, not a pill').toBeGreaterThanOrEqual(88)
    expect(t.title, 'the whole title').not.toContain('…')
  }
  expect(tiles.map((t) => t.title).sort()).toEqual([
    'Duplicate candidates in the Payroll clerk CV screenings',
    'Payroll clerk CV screenings',
  ])
})

// The inspector reads as words, not code: each link a row with its words at the left (wrapping if long) and
// a compact Inspect on its first line at the right; the page's type, status and address as plain text.
test('the inspector: link rows keep Inspect at the right of their first line; no code type', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(GRAPH)
  await settled(page)
  await page.locator('canvas.graph-canvas').focus()
  await page.keyboard.press('Enter')
  const inspector = page.getByRole('complementary', { name: /^Inspector \S/ })
  await expect(inspector.getByRole('link', { name: 'Open page' })).toBeVisible()
  const rows = inspector.locator('.inspector-links li')
  await expect(rows.first()).toBeVisible()
  const seen = await rows.evaluateAll((lis) =>
    lis
      .filter((li) => li.querySelector('button'))
      .map((li) => {
        const r = li.getBoundingClientRect()
        const b = (li.querySelector('button') as HTMLElement).getBoundingClientRect()
        return { top: b.top - r.top, right: r.right - b.right, h: b.height, w: b.width }
      }),
  )
  expect(seen.length).toBeGreaterThan(1)
  for (const s of seen) {
    expect(s.top, 'on the first line').toBeLessThanOrEqual(4)
    expect(s.right, 'at the right').toBeLessThanOrEqual(1)
    expect(Math.min(s.h, s.w)).toBeGreaterThanOrEqual(24)
  }
  // No code type: tags and the address are set in the interface's own face, never a face of their own (the
  // spec amendment of 2026-11-09 makes that face monospaced for the whole interface).
  const body = await page.evaluate(() => getComputedStyle(document.body).fontFamily)
  const fonts = await inspector
    .locator('.tags .tag, .inspector-address')
    .evaluateAll((els) => els.map((e) => getComputedStyle(e).fontFamily))
  expect(fonts.length).toBeGreaterThanOrEqual(2)
  for (const f of fonts) expect(f).toBe(body)
})

// Closing review C5: the cards' words and sizes for the tests are made only when a test drives the browser
// (navigator.webdriver); a person's browser never builds them, picture after picture.
test('outside a test the painter does not build the cards’ list for tests', async ({
  page,
  context,
  baseURL,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }),
  )
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto(GRAPH)
  await settled(page)
  const canvas = page.locator('canvas.graph-canvas')
  await expect.poll(async () => Number(await canvas.getAttribute('data-cards'))).toBeGreaterThan(0)
  await expect(canvas).not.toHaveAttribute('data-card-list', /./)
})

// reference. At Fit nothing is named but the hub and the families' pills; a page picked is named with its
// neighbours and nothing else; the pointer on a point names it.
test('the still cloud names only the picked page and its neighbours; the pointer names the rest', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(GRAPH)
  await settled(page)
  await upToDate(page)
  const canvas = page.locator('canvas.graph-canvas')
  const named = async () =>
    Number(await canvas.getAttribute('data-cards')) + Number(await canvas.getAttribute('data-labels'))
  expect(await named()).toBe(0)
  await expect(canvas).toHaveAttribute('data-families', /,/)
  // Picked: its card, and at most its neighbours'.
  await canvas.focus()
  await page.keyboard.press('Enter')
  const inspector = page.getByRole('complementary', { name: /^Inspector \S/ })
  await expect(inspector.getByRole('link', { name: 'Open page' })).toBeVisible()
  await upToDate(page)
  const links = await inspector.locator('.inspector-links li').count()
  const picked = await named()
  expect(picked).toBeGreaterThan(0)
  expect(picked).toBeLessThanOrEqual(1 + links)
  await expect(canvas).toHaveAttribute('data-selected-card', /\d+,\d+,\d+,\d+/)
  // Nothing picked, the pointer on a point names it.
  await page.keyboard.press('Escape')
  await expect(inspector).toHaveCount(0)
  await canvas.blur()
  await upToDate(page)
  const b = (await canvas.boundingBox()) as { x: number; y: number; width: number; height: number }
  let found = false
  for (let y = 0.3; y < 0.8 && !found; y += 0.02)
    for (let x = 0.3; x < 0.75 && !found; x += 0.01) {
      await page.mouse.move(b.x + b.width * x, b.y + b.height * y)
      found = (await canvas.getAttribute('data-hover')) !== null
    }
  expect(found, 'a point under the pointer').toBe(true)
  await upToDate(page)
  expect(await named()).toBeGreaterThan(0)
})

// Review R4: what the pointer picks and where the cards go are checked with the cloud still (reduced motion)
// and with motion allowed, where a touch stops the turn and the picture is still again.
function pickingAndClearance() {
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
    // The keyboard's page always has its card. Read once the keyboard is on the canvas and nothing has moved
    // it since (a card read before a move would belong to the page before).
    await expect(canvas).not.toHaveAttribute('data-active-card', /./)
    await canvas.focus()
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
    // A pill (28 px) or, zoomed in, a tile.
    expect(h === 28 || h >= 88).toBe(true)
    // Two pixels inside its right edge: far from the page's point, still its card.
    await canvas.click({ position: { x: x + w - 2, y: y + h / 2 } })
    const inspector = page.getByRole('complementary', { name: /^Inspector \S/ })
    await expect(inspector.getByRole('heading', { level: 2 })).toHaveText(title)
  })

  // Review A1: with the panel open, the keyboard's page is kept in the part of the canvas the panel and the
  // controls leave: its card never ends under the panel.
  test('with the inspector open, walking right keeps the keyboard’s card clear of the panel', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto(GRAPH)
    await settled(page)
    const canvas = page.locator('canvas.graph-canvas')
    await page.getByRole('button', { name: 'Inspector', exact: true }).click()
    const c = await box(page, 'canvas.graph-canvas')
    const panel = await box(page, '#graph-inspector')
    await canvas.focus()
    await page.keyboard.press('+')
    await page.keyboard.press('+')
    await page.keyboard.press('+')
    const end = async () => {
      const [x, , w] = ((await canvas.getAttribute('data-active-card')) ?? '0,0,0,0')
        .split(',')
        .map(Number) as [number, number, number]
      return c.left + x + w
    }
    for (let n = 0; n < 12; n++) {
      await page.keyboard.press('ArrowRight')
      await expect
        .poll(end, { message: `step ${n}: the card ends left of the panel` })
        .toBeLessThan(panel.left)
    }
  })

  // Review A4: a page picked at the right edge is brought clear of the panel that opens for it, whether or
  // not the view was the person's own.
  for (const zoomed of [false, true])
    test(`a page picked at the right edge is drawn clear of the panel${zoomed ? ', zoomed in' : ''}`, async ({
      page,
      context,
      baseURL,
    }) => {
      await scenario(context, baseURL as string, 'signed-in')
      await page.setViewportSize({ width: 1366, height: 768 })
      await page.goto(GRAPH)
      await settled(page)
      const canvas = page.locator('canvas.graph-canvas')
      await canvas.focus()
      if (zoomed) await page.keyboard.press('+')
      for (let n = 0; n < 8; n++) await page.keyboard.press('ArrowRight')
      await page.keyboard.press('Enter')
      await expect(page.getByRole('complementary', { name: /^Inspector \S/ })).toBeVisible()
      const c = await box(page, 'canvas.graph-canvas')
      const panel = await box(page, '#graph-inspector')
      await expect
        .poll(async () => {
          const [x, , w] = ((await canvas.getAttribute('data-selected-card')) ?? '9999,0,0,0')
            .split(',')
            .map(Number) as [number, number, number]
          return c.left + x + w
        })
        .toBeLessThan(panel.left)
    })

  // Review R2-1: whatever scale Fit lands on with the panel open, every card it draws is whole: inside the
  // canvas and left of the panel (tiles never keep the narrow pad of the pills).
  for (const size of [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1280, height: 720 },
    { width: 1100, height: 900 },
  ])
    test(`Fit with the panel open draws every card whole at ${size.width}×${size.height}`, async ({
      page,
      context,
      baseURL,
    }) => {
      await scenario(context, baseURL as string, 'signed-in')
      await page.setViewportSize(size)
      await page.goto(GRAPH)
      await settled(page)
      await page.getByRole('button', { name: 'Inspector', exact: true }).click()
      const canvas = page.locator('canvas.graph-canvas')
      const sent = Number(await canvas.getAttribute('data-sent-seq'))
      await page.getByRole('button', { name: 'Fit', exact: true }).click()
      // The picture of the state Fit sent, not one already on its way (review R3-2).
      await expect.poll(async () => Number(await canvas.getAttribute('data-sent-seq'))).toBeGreaterThan(sent)
      await upToDate(page)
      const c = await box(page, 'canvas.graph-canvas')
      const panel = await box(page, '#graph-inspector')
      const cards = JSON.parse((await canvas.getAttribute('data-card-list')) ?? '[]') as {
        x: number
        y: number
        w: number
        h: number
        title: string
      }[]
      expect(cards.length).toBeGreaterThan(0)
      for (const k of cards) {
        expect(k.x, `${k.title} inside the canvas`).toBeGreaterThanOrEqual(0)
        expect(k.y, `${k.title} inside the canvas`).toBeGreaterThanOrEqual(0)
        expect(k.y + k.h, `${k.title} inside the canvas`).toBeLessThanOrEqual(c.bottom - c.top)
        expect(c.left + k.x + k.w, `${k.title} left of the panel`).toBeLessThanOrEqual(panel.left)
      }
    })

  // Review R2-2: with Fit on (auto), a page picked by pointer at the right edge, drawn as a point until then,
  // gets its card clear of the panel. Narrow, tall windows: the picture fills the width, up to the panel.
  for (const size of [
    { width: 1100, height: 1000 },
    { width: 1200, height: 1080 },
  ])
    test(`with Fit on, a point picked at the right edge gets its card clear of the panel at ${size.width}`, async ({
      page,
      context,
      baseURL,
    }) => {
      await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
      await page.setViewportSize(size)
      await page.goto(GRAPH)
      await settled(page)
      await page.getByRole('button', { name: 'Inspector', exact: true }).click()
      await page.getByRole('button', { name: 'Fit', exact: true }).click()
      await upToDate(page)
      const panel = await box(page, '#graph-inspector')
      // The rightmost point under the pointer (not a card) in the part the panel leaves.
      const spot = await page.locator('canvas.graph-canvas').evaluate((c, right) => {
        const el = c as HTMLCanvasElement
        const r = el.getBoundingClientRect()
        const cards = JSON.parse(el.dataset.cardList ?? '[]') as {
          x: number
          y: number
          w: number
          h: number
        }[]
        for (let x = right - 30; x > right - 200; x -= 3)
          for (let y = r.top + 120; y < r.bottom - 80; y += 3) {
            if (
              cards.some(
                (k) =>
                  x - r.left >= k.x && x - r.left <= k.x + k.w && y - r.top >= k.y && y - r.top <= k.y + k.h,
              )
            )
              continue
            el.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }))
            if (el.dataset.hover !== undefined) return { x: x - r.left, y: y - r.top }
          }
        return null
      }, panel.left)
      expect(spot, 'a point near the panel').not.toBeNull()
      const canvas = page.locator('canvas.graph-canvas')
      await canvas.click({ position: spot as { x: number; y: number } })
      await expect(page.getByRole('complementary', { name: /^Inspector \S/ })).toBeVisible()
      const c = await box(page, 'canvas.graph-canvas')
      await expect
        .poll(async () => {
          const [x, , w] = ((await canvas.getAttribute('data-selected-card')) ?? '9999,0,0,0')
            .split(',')
            .map(Number) as [number, number, number]
          return c.left + x + w
        })
        .toBeLessThan(panel.left)
    })

  // Closing review C4: a link that names the page to inspect opens the panel with it, and its card is drawn
  // clear of the panel, at every width the panel shows.
  for (const size of [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1100, height: 1000 },
  ])
    for (const seeded of [undefined, 300] as const)
      test(`a link with ?inspect opens the panel, its page clear of it, ${size.width}, ${seeded ?? 11} pages`, async ({
        page,
        context,
        baseURL,
      }) => {
        await scenario(context, baseURL as string, 'signed-in', {}, seeded ? { seeded } : {})
        await page.setViewportSize(size)
        const address = seeded ? 'product/segment/incident' : 'audience/retention'
        await page.goto(`${GRAPH}?inspect=${encodeURIComponent(`p:${address}`)}`)
        await settled(page)
        await expect(page.getByRole('complementary', { name: /^Inspector \S/ })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Inspector', exact: true })).toHaveAttribute(
          'aria-expanded',
          'true',
        )
        await upToDate(page)
        const c = await box(page, 'canvas.graph-canvas')
        const panel = await box(page, '#graph-inspector')
        const canvas = page.locator('canvas.graph-canvas')
        await expect(canvas).toHaveAttribute('data-selected-card', /\d+,\d+,\d+,\d+/)
        const [x, y, w, h] = ((await canvas.getAttribute('data-selected-card')) ?? '')
          .split(',')
          .map(Number) as [number, number, number, number]
        expect(c.left + x + w, 'left of the panel').toBeLessThanOrEqual(panel.left)
        expect(x).toBeGreaterThanOrEqual(0)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y + h).toBeLessThanOrEqual(c.bottom - c.top)
      })

  // Closing review, visual gap 2: no card is drawn under the canvas's controls (the legend, the zoom tools, the
  // bars at the top, the panel's switch) nor under the open panel, at Fit or zoomed in.
  for (const zoom of [0, 2])
    test(`no card under the canvas controls, panel open${zoom ? ', zoomed in' : ''}`, async ({
      page,
      context,
      baseURL,
    }) => {
      await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
      await page.setViewportSize({ width: 1920, height: 1080 })
      await page.goto(GRAPH)
      await settled(page)
      const canvas = page.locator('canvas.graph-canvas')
      await canvas.focus()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('complementary', { name: /^Inspector \S/ })).toBeVisible()
      for (let n = 0; n < zoom; n++) await page.keyboard.press('+')
      await upToDate(page)
      const c = await box(page, 'canvas.graph-canvas')
      const controls = await Promise.all(
        [
          '.graph-legend',
          '.graph-tools',
          '.graph-over',
          '.graph-center',
          '.inspector-toggle',
          '#graph-inspector',
        ].map((q) => box(page, q)),
      )
      const cards = JSON.parse((await canvas.getAttribute('data-card-list')) ?? '[]') as {
        x: number
        y: number
        w: number
        h: number
        title: string
      }[]
      const picked = (await canvas.getAttribute('data-selected-card')) ?? ''
      expect(cards.length).toBeGreaterThan(0)
      for (const k of cards) {
        if (`${k.x},${k.y},${k.w},${k.h}` === picked) continue
        const r = {
          left: c.left + k.x,
          top: c.top + k.y,
          right: c.left + k.x + k.w,
          bottom: c.top + k.y + k.h,
        }
        for (const b of controls)
          expect(
            r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top,
            `${k.title} under a control`,
          ).toBe(false)
      }
    })

  // Closing review, visual gap 3, revised by the style polish (2026-11-09): the still cloud is quiet like the
}

test.describe('reduced motion', () => pickingAndClearance())
test.describe('motion allowed', () => {
  test.use({ reducedMotion: 'no-preference' })
  pickingAndClearance()
})
