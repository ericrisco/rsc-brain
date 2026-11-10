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

type Item = { key: string; x: number; y: number; shown: boolean }
const items = (page: Page) =>
  page.evaluate(() => (window as unknown as { __graph: { items(): Item[] } }).__graph.items())

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
// left with their names and keys, the communities at the right.
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
  // The communities (v0.5.0): at the right, under the strip and the panel's switch, clear of the zoom tools.
  const communities = await box(page, '.graph-communities')
  expect(canvas.right - communities.right).toBeLessThan(32)
  expect(communities.top).toBeGreaterThan(title.bottom)
  expect(communities.top).toBeGreaterThanOrEqual((await box(page, '.inspector-toggle')).bottom)
  expect(communities.left, 'clear of the middle').toBeGreaterThan(mid)
  expect(communities.bottom).toBeLessThan(canvas.bottom)
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
  // Each arrow moves the keyboard to another page (Right then Down may come
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

// CA9: the page picked and the page under the keyboard are told apart by shape: a solid ring close around the
// page picked, a dashed one further out around the keyboard's page.
test('CA9: picked and under the keyboard differ by shape, not by colour alone', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(GRAPH)
  await settled(page)
  const canvas = page.locator('canvas.graph-canvas')
  await canvas.focus()
  await page.keyboard.press('Enter')
  await expect(canvas).toHaveAttribute('data-selected', /\d+,\d+/)
  const picked = await canvas.getAttribute('data-selected')
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => canvas.getAttribute('data-active')).not.toBe(picked)
  await upToDate(page)
  const rings = Object.fromEntries(
    ((await canvas.getAttribute('data-rings')) ?? '').split(' ').map((r) => {
      const [what, line, radius] = r.split(':')
      return [what, { line, radius: Number(radius) }]
    }),
  ) as Record<string, { line: string; radius: number }>
  expect(rings.selected?.line).toBe('solid')
  expect(rings.active?.line).toBe('dashed')
  // Drawn: the keyboard's ring is inked around its page, all the way round where it is not a gap.
  const c = await box(page, 'canvas.graph-canvas')
  const [ax, ay] = ((await canvas.getAttribute('data-active')) ?? '').split(',').map(Number) as [
    number,
    number,
  ]
  const r = rings.active?.radius ?? 0
  const shot = await page.screenshot({
    clip: { x: c.left + ax - r - 4, y: c.top + ay - r - 4, width: 2 * r + 8, height: 2 * r + 8 },
  })
  const inked = await page.evaluate(
    async ([b64, radius]) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const k = document.createElement('canvas')
      k.width = img.width
      k.height = img.height
      const x = k.getContext('2d') as CanvasRenderingContext2D
      x.drawImage(img, 0, 0)
      const ground = getComputedStyle(document.documentElement).getPropertyValue('--ground').trim()
      const sw = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D
      sw.fillStyle = ground
      sw.fillRect(0, 0, 1, 1)
      const g = sw.getImageData(0, 0, 1, 1).data
      let on = 0
      const steps = 72
      for (let s = 0; s < steps; s++) {
        const a = (s / steps) * Math.PI * 2
        const px = Math.round(k.width / 2 + Math.cos(a) * (radius as number))
        const py = Math.round(k.height / 2 + Math.sin(a) * (radius as number))
        const d = x.getImageData(px, py, 1, 1).data
        if (
          Math.abs((d[0] ?? 0) - (g[0] ?? 0)) +
            Math.abs((d[1] ?? 0) - (g[1] ?? 0)) +
            Math.abs((d[2] ?? 0) - (g[2] ?? 0)) >
          60
        )
          on += 1
      }
      return on / steps
    },
    [shot.toString('base64'), r] as const,
  )
  // Dashed: much of the way round, with gaps.
  expect(inked).toBeGreaterThan(0.3)
  expect(inked).toBeLessThan(0.95)
  expect(rings.active?.radius ?? 0, 'further out').toBeGreaterThan(rings.selected?.radius ?? 0)
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

// Closing review C5: what the picture says to tests (its counts and rings) is made only when a test drives the
// browser (navigator.webdriver); a person's browser never builds it, picture after picture.
test('outside a test the painter does not build what it tells tests', async ({ page, context, baseURL }) => {
  await page.addInitScript(() =>
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }),
  )
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto(GRAPH)
  await settled(page)
  const canvas = page.locator('canvas.graph-canvas')
  await canvas.focus()
  await expect(canvas).toHaveAttribute('data-active', /\d+,\d+/)
  for (const a of ['data-counts', 'data-rings', 'data-active-here'])
    await expect(canvas).not.toHaveAttribute(a, /./)
  expect(await page.evaluate(() => '__graph' in window)).toBe(false)
})

// Review R4: what the pointer picks and where a page picked is drawn are checked at rest with reduced motion and
// with motion allowed (v0.5.0: the layout settles, and then the picture is still).
function pickingAndClearance() {
  const xyOf = async (page: Page, attr: string) =>
    ((await page.locator('canvas.graph-canvas').getAttribute(attr)) ?? '').split(',').map(Number) as [
      number,
      number,
    ]
  // The left edge of whatever covers the right of the canvas: the inspector, and the communities left of it.
  const coverLeft = async (page: Page) =>
    Math.min((await box(page, '#graph-inspector')).left, (await box(page, '.graph-communities')).left)

  // A click on a page, a little off its middle, picks it.
  test('a click near a page opens it in the inspector', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto(GRAPH)
    await settled(page)
    const canvas = page.locator('canvas.graph-canvas')
    await canvas.focus()
    await expect(canvas).toHaveAttribute('data-active', /^-?\d+,-?\d+$/)
    const said =
      (await page
        .locator('[aria-live="polite"]')
        .filter({ hasText: /Enter to inspect/ })
        .textContent()) ?? ''
    const title = said.split('. ')[0] as string
    const [x, y] = await xyOf(page, 'data-active')
    await canvas.click({ position: { x: x + 3, y: y - 2 } })
    const inspector = page.getByRole('complementary', { name: /^Inspector \S/ })
    await expect(inspector.getByRole('heading', { level: 2 })).toHaveText(title)
  })

  // Review A1: with the panel open, the keyboard's page is kept in the part of the canvas the panels and the
  // controls leave: it never ends under them.
  test('with the inspector open, walking right keeps the keyboard’s page clear of the panels', async ({
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
    await canvas.focus()
    await page.keyboard.press('+')
    await page.keyboard.press('+')
    await page.keyboard.press('+')
    const cover = await coverLeft(page)
    for (let n = 0; n < 12; n++) {
      await page.keyboard.press('ArrowRight')
      await expect
        .poll(async () => c.left + (await xyOf(page, 'data-active'))[0], {
          message: `step ${n}: the page is left of the panels`,
        })
        .toBeLessThan(cover)
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
      await expect(canvas).toHaveAttribute('data-selected', /\d+,\d+/)
      await expect
        .poll(async () => c.left + (await xyOf(page, 'data-selected'))[0] + 12)
        .toBeLessThan(panel.left)
    })

  // Review R2-1: Fit with the panel open draws every page inside the canvas, left of the panels and clear of
  // the controls at the top and bottom.
  for (const size of [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1280, height: 720 },
    { width: 1100, height: 900 },
  ])
    test(`Fit with the panel open draws every page in the room left at ${size.width}×${size.height}`, async ({
      page,
      context,
      baseURL,
    }) => {
      await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
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
      const cover = await coverLeft(page)
      const shown = (await items(page)).filter((it) => it.shown)
      expect(shown.length).toBeGreaterThan(0)
      for (const it of shown) {
        expect(it.x, `${it.key} inside the canvas`).toBeGreaterThanOrEqual(0)
        expect(it.y, `${it.key} inside the canvas`).toBeGreaterThanOrEqual(0)
        expect(it.y, `${it.key} inside the canvas`).toBeLessThanOrEqual(c.bottom - c.top)
        expect(c.left + it.x, `${it.key} left of the panels`).toBeLessThanOrEqual(cover)
      }
    })

  // Closing review C4: a link that names the page to inspect opens the panel with it, and the page is drawn
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
        await expect(canvas).toHaveAttribute('data-selected', /\d+,\d+/)
        const [x, y] = await xyOf(page, 'data-selected')
        expect(c.left + x, 'left of the panel').toBeLessThan(panel.left)
        expect(x).toBeGreaterThanOrEqual(0)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThanOrEqual(c.bottom - c.top)
      })

  // Closing review, visual gap 2: at Fit no page is drawn under the canvas's controls (the zoom tools, the
  // bars at the top, the panel's switch, the communities) nor under the open panel.
  test('at Fit no page under the canvas controls, panel open', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto(GRAPH)
    await settled(page)
    const canvas = page.locator('canvas.graph-canvas')
    await canvas.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('complementary', { name: /^Inspector \S/ })).toBeVisible()
    await page.getByRole('button', { name: 'Fit', exact: true }).click()
    await upToDate(page)
    const c = await box(page, 'canvas.graph-canvas')
    const controls = await Promise.all(
      [
        '.graph-tools',
        '.graph-over',
        '.graph-center',
        '.inspector-toggle',
        '#graph-inspector',
        '.graph-communities',
      ].map((q) => box(page, q)),
    )
    for (const it of (await items(page)).filter((x) => x.shown)) {
      const x = c.left + it.x
      const y = c.top + it.y
      for (const b of controls)
        expect(x > b.left && x < b.right && y > b.top && y < b.bottom, `${it.key} under a control`).toBe(
          false,
        )
    }
  })
}

test.describe('reduced motion', () => pickingAndClearance())
test.describe('motion allowed', () => {
  test.use({ reducedMotion: 'no-preference' })
  pickingAndClearance()
})
