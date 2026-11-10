// v0.5.0: the graph as a live picture in two dimensions. A page dragged follows the pointer and pulls its
// neighbours, and the picture comes to rest once it is let go; no words on the canvas until the pointer is on a
// page (a tooltip with its title and address) or it is clicked (the inspector, in words big enough to read);
// the pages without links on a ring around the rest; the Communities panel names the clusters the picture is
// coloured by and hides them; nothing travels the lines, and with reduced motion nothing is animated.
import type { Page } from '@playwright/test'
import { expect, scenario, test } from './fixture.ts'

const GRAPH = '/b/growth/wiki/graph'
const settled = (page: Page) =>
  expect(page.locator('canvas.graph-canvas[data-settled]')).toHaveCount(1, { timeout: 30_000 })
const atRest = (page: Page) =>
  expect(page.locator('canvas.graph-canvas')).toHaveAttribute('data-moving', 'false', { timeout: 30_000 })

type Item = {
  key: string
  x: number
  y: number
  role: number
  community: number
  colour: number
  shown: boolean
  near: number[]
}
const items = (page: Page) =>
  page.evaluate(() => (window as unknown as { __graph: { items(): Item[] } }).__graph.items())
const canvasBox = async (page: Page) =>
  (await page.locator('canvas.graph-canvas').boundingBox()) as {
    x: number
    y: number
    width: number
    height: number
  }

// A linked page well inside the canvas (clear of the panels), and one of its neighbours.
async function linkedPage(page: Page) {
  const all = await items(page)
  const b = await canvasBox(page)
  const k = all.findIndex(
    (it) =>
      it.role === 0 &&
      it.shown &&
      it.near.length >= 2 &&
      it.x > b.width * 0.25 &&
      it.x < b.width * 0.5 &&
      it.y > b.height * 0.3 &&
      it.y < b.height * 0.7,
  )
  expect(k).toBeGreaterThanOrEqual(0)
  return { all, k, item: all[k] as Item, b }
}

test.describe('moving (motion allowed)', () => {
  test.use({ reducedMotion: 'no-preference' })

  test('a page dragged follows the pointer, pulls its neighbours, and the picture rests once it is let go', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.goto(GRAPH)
    await settled(page)
    await atRest(page)
    const { all, k, item, b } = await linkedPage(page)
    const near = item.near.filter((j) => (all[j] as Item).role === 0)
    const far = all.findIndex(
      (it, j) =>
        it.role === 0 && j !== k && !item.near.includes(j) && Math.hypot(it.x - item.x, it.y - item.y) > 250,
    )
    expect(far).toBeGreaterThanOrEqual(0)
    await page.mouse.move(b.x + item.x, b.y + item.y)
    await page.mouse.down()
    const to = { x: item.x + 160, y: item.y + 90 }
    for (let s = 1; s <= 12; s++)
      await page.mouse.move(
        b.x + item.x + ((to.x - item.x) * s) / 12,
        b.y + item.y + ((to.y - item.y) * s) / 12,
      )
    // Held: it moves with the pointer, the picture moves, and its neighbours come along more than a far page.
    await expect(page.locator('canvas.graph-canvas')).toHaveAttribute('data-moving', 'true')
    await page.waitForTimeout(600)
    const during = await items(page)
    const held = during[k] as Item
    expect(Math.hypot(held.x - to.x, held.y - to.y), 'under the pointer').toBeLessThan(4)
    const moved = (j: number) =>
      Math.hypot((during[j] as Item).x - (all[j] as Item).x, (during[j] as Item).y - (all[j] as Item).y)
    const pulled = Math.max(...near.map(moved))
    expect(pulled, 'a neighbour follows').toBeGreaterThan(15)
    expect(pulled).toBeGreaterThan(moved(far))
    // Let go: it is not pinned, and the picture comes to rest again (and stays still).
    await page.mouse.up()
    await atRest(page)
    const after = await items(page)
    const draws = Number(await page.locator('canvas.graph-canvas').getAttribute('data-draws'))
    await page.waitForTimeout(800)
    expect(
      Number(await page.locator('canvas.graph-canvas').getAttribute('data-draws')),
      'still at rest',
    ).toBe(draws)
    const back = after[k] as Item
    expect(Math.hypot(back.x - to.x, back.y - to.y), 'let go, the layout takes it back').toBeGreaterThan(4)
    // A drag is not a click: nothing was picked.
    await expect(page.getByRole('complementary', { name: /^Inspector \S/ })).toHaveCount(0)
  })

  test('at rest nothing is drawn again: no light travels the lines', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.goto(GRAPH)
    await settled(page)
    await atRest(page)
    const canvas = page.locator('canvas.graph-canvas')
    const draws = Number(await canvas.getAttribute('data-draws'))
    await page.waitForTimeout(1500)
    expect(Number(await canvas.getAttribute('data-draws'))).toBe(draws)
    // The cloud's marks are gone: no turn, no pulses, no fact card.
    for (const gone of ['data-yaw', 'data-spinning', 'data-pulses', 'data-fact', 'data-cards', 'data-labels'])
      expect(await canvas.getAttribute(gone), gone).toBeNull()
  })
})

test('with reduced motion a page dragged moves alone, and the picture is drawn at rest once let go', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.goto(GRAPH)
  await settled(page)
  const canvas = page.locator('canvas.graph-canvas')
  await expect(canvas).toHaveAttribute('data-frames', '1')
  const { all, k, item, b } = await linkedPage(page)
  const near = item.near[0] as number
  await page.mouse.move(b.x + item.x, b.y + item.y)
  await page.mouse.down()
  await page.mouse.move(b.x + item.x + 60, b.y + item.y + 40, { steps: 6 })
  await expect.poll(async () => Math.round(((await items(page))[k] as Item).x)).toBe(Math.round(item.x + 60))
  const during = await items(page)
  expect((during[near] as Item).x, 'nothing else moves while it is held').toBeCloseTo(
    (all[near] as Item).x,
    0,
  )
  const frames = Number(await canvas.getAttribute('data-frames'))
  await page.mouse.up()
  // Let go: one more picture, at rest; nothing in between.
  await expect.poll(async () => Number(await canvas.getAttribute('data-frames'))).toBe(frames + 1)
  await expect(canvas).toHaveAttribute('data-moving', 'false')
  await page.waitForTimeout(500)
  expect(Number(await canvas.getAttribute('data-frames'))).toBe(frames + 1)
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
})

test('no words on the canvas: the pointer on a page shows its title and address beside it', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.goto(GRAPH)
  await settled(page)
  const tip = page.locator('.graph-tip')
  await expect(tip).toBeHidden()
  const { item, b } = await linkedPage(page)
  const address = item.key.slice(2)
  const title = await page.evaluate(async (a) => {
    const r = await fetch('/v1/brains/growth/wiki/graph')
    const nodes = ((await r.json()) as { nodes: [string, string][] }).nodes
    return nodes.find((n) => n[0] === a)?.[1] ?? ''
  }, address)
  await page.mouse.move(b.x + item.x, b.y + item.y)
  await expect(tip).toBeVisible()
  await expect(tip.locator('.tip-title')).toHaveText(title)
  await expect(tip.locator('.tip-sub')).toHaveText(address)
  // Beside the page, readable.
  const t = (await tip.boundingBox()) as { x: number; y: number; width: number; height: number }
  expect(Math.abs(t.x - (b.x + item.x))).toBeLessThan(40 + t.width)
  expect(Math.abs(t.y - (b.y + item.y))).toBeLessThan(60)
  expect(
    await tip.locator('.tip-title').evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(14)
  // The page and its lines are brightened, the rest a little dimmed.
  const counts = async () =>
    ((await page.locator('canvas.graph-canvas').getAttribute('data-counts')) ?? '').split(',').map(Number)
  await expect.poll(async () => (await counts())[1] ?? 0).toBeGreaterThan(0)
  expect((await counts())[0]).toBe(new Set(item.near).size + 1)
  // Off the page: no tooltip, nothing dimmed.
  await page.mouse.move(b.x + 5, b.y + b.height - 5)
  await expect(tip).toBeHidden()
  await expect.poll(async () => (await counts())[1]).toBe(0)
})

test('a click on a page opens it in words big enough to read; it and its neighbours stay bright, the rest dims', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.goto(GRAPH)
  await settled(page)
  const { item, b } = await linkedPage(page)
  await page.mouse.click(b.x + item.x, b.y + item.y)
  const panel = page.getByRole('complementary', { name: /^Inspector \S/ })
  await expect(panel).toBeVisible()
  await expect(panel.locator('.inspector-address')).toHaveText(item.key.slice(2))
  await expect(panel.getByRole('link', { name: 'Open page' })).toBeVisible()
  await expect(panel.locator('.summary')).toBeVisible()
  const size = (sel: string) =>
    panel
      .locator(sel)
      .first()
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))
  expect(await size('.inspector-title')).toBeGreaterThanOrEqual(18)
  expect(await size('.summary')).toBeGreaterThanOrEqual(14)
  expect(await size('.inspector-links li')).toBeGreaterThanOrEqual(13)
  // Off the canvas, the picture says the page picked: it and its neighbours bright, the rest dimmed.
  await page.mouse.move(b.x + 5, b.y + b.height - 5)
  await expect
    .poll(async () => (await page.locator('canvas.graph-canvas').getAttribute('data-counts')) ?? '')
    .toMatch(new RegExp(`^${new Set(item.near).size + 1},[1-9]\\d*,`))
  // A link of the panel moves the pick.
  await panel
    .getByRole('button', { name: /^Inspect / })
    .first()
    .click()
  await expect(panel.locator('.inspector-address')).not.toHaveText(item.key.slice(2))
})

test('the pages without links sit evenly on a ring around all the others', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 'loose' })
  await page.goto(GRAPH)
  await settled(page)
  const all = (await items(page)).filter((it) => it.shown)
  const linked = all.filter((it) => it.role === 0)
  const lone = all.filter((it) => it.role === 1)
  expect(lone.length).toBeGreaterThan(2)
  const xs = linked.map((it) => it.x)
  const ys = linked.map((it) => it.y)
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2
  const reach = Math.max(...linked.map((it) => Math.hypot(it.x - cx, it.y - cy)))
  const radii = lone.map((it) => Math.hypot(it.x - cx, it.y - cy))
  for (const r of radii) {
    expect(r, 'outside the linked pages').toBeGreaterThan(reach)
    expect(Math.abs(r - (radii[0] as number)), 'on one ring').toBeLessThan(2)
  }
  // In their own colour, and listed as "No links".
  expect(new Set(lone.map((it) => it.colour)).size).toBe(1)
  expect(linked.some((it) => it.colour === lone[0]?.colour)).toBe(false)
  await expect(page.locator('.graph-communities').getByText('No links')).toBeVisible()
})

test('the Communities panel lists the clusters the picture is coloured by, biggest first, and hides them', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 'loose' })
  await page.goto(GRAPH)
  await settled(page)
  const panel = page.locator('.graph-communities')
  await expect(panel.getByRole('checkbox', { name: 'Select all' })).toBeChecked()
  const rows = panel.locator('ul .com-row')
  const n = await rows.count()
  expect(n).toBeGreaterThan(2)
  const counts = await panel.locator('ul .com-count').allTextContents()
  const firstCounts = counts.slice(0, -1).map((c) => Number(c.replace(/,/g, '')))
  expect(firstCounts, 'biggest first').toEqual([...firstCounts].sort((a, b) => b - a))
  // Each row has its colour: the first community's.
  const before = await items(page)
  const first = before.find((it) => it.community === 0) as Item
  expect(first).toBeTruthy()
  const firstName = (await rows.first().locator('.com-name').textContent()) ?? ''
  // Unticked, its pages go, with their lines; the others stay.
  await rows.first().getByRole('checkbox').uncheck()
  await expect
    .poll(async () => (await items(page)).filter((it) => it.community === 0 && it.shown).length)
    .toBe(0)
  const after = await items(page)
  expect(after.filter((it) => it.community !== 0 && it.shown).length).toBe(
    before.filter((it) => it.community !== 0 && it.shown).length,
  )
  await expect(panel.getByRole('checkbox', { name: 'Select all' })).not.toBeChecked()
  // Hover does not find a hidden page.
  await expect(page.getByRole('application', { name: /^Graph of \d+ items$/ })).toHaveAttribute(
    'aria-label',
    `Graph of ${after.filter((it) => it.shown).length} items`,
  )
  // Select all brings every one back; unticking it hides them all.
  await panel.getByRole('checkbox', { name: 'Select all' }).check()
  await expect
    .poll(async () => (await items(page)).filter((it) => it.shown).length)
    .toBe(before.filter((it) => it.shown).length)
  await panel.getByRole('checkbox', { name: 'Select all' }).uncheck()
  await expect.poll(async () => (await items(page)).filter((it) => it.shown).length).toBe(0)
  await panel.getByRole('checkbox', { name: 'Select all' }).check()
  expect(firstName.length).toBeGreaterThan(0)
  // The panel folds from its head, and never covers the middle of the picture.
  const c = await canvasBox(page)
  const p = (await panel.boundingBox()) as { x: number; y: number; width: number; height: number }
  expect(p.x).toBeGreaterThan(c.x + c.width / 2)
  await panel.locator('summary').click()
  await expect(rows.first()).toBeHidden()
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

// Review R2: after a filter what is left is fitted again, so every page moves on screen. The pointer finds
// pages on the page's copy of the positions; that copy must be the one the painter drew with. data-active is
// where the painter drew the keyboard's page; data-active-here is where the page's copy puts it.
test.describe('R2: a filter moves every page; the pointer follows', () => {
  for (const motion of ['reduce', 'no-preference'] as const)
    test(`the page hit-tests the positions the painter drew after a filter (${motion})`, async ({
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
      await atRest(page)
      const canvas = page.locator('canvas.graph-canvas')
      await canvas.focus()
      await expect(canvas).toHaveAttribute('data-active', /\d+,\d+/)
      await expect
        .poll(async () => {
          const a = ((await canvas.getAttribute('data-active')) ?? '').split(',').map(Number)
          const b = ((await canvas.getAttribute('data-active-here')) ?? '').split(',').map(Number)
          return (
            b.length === 2 &&
            Math.abs((a[0] ?? 0) - (b[0] ?? 0)) <= 1 &&
            Math.abs((a[1] ?? 0) - (b[1] ?? 0)) <= 1
          )
        })
        .toBe(true)
    })
})

test.describe('out of sight and less motion (motion allowed)', () => {
  test.use({ reducedMotion: 'no-preference' })
  // Holds a page, so the layout keeps moving until the test lets it go.
  const hold = async (page: Page) => {
    await settled(page)
    await atRest(page)
    const { item, b } = await linkedPage(page)
    await page.mouse.move(b.x + item.x, b.y + item.y)
    await page.mouse.down()
    await page.mouse.move(b.x + item.x + 80, b.y + item.y + 30, { steps: 5 })
    await expect(page.locator('canvas.graph-canvas')).toHaveAttribute('data-moving', 'true')
  }
  const still = async (page: Page) => {
    const canvas = page.locator('canvas.graph-canvas')
    await expect(canvas).toHaveAttribute('data-moving', 'false')
    // The one picture at rest that letting go asks for may still be on its way; after it, nothing.
    await page.waitForTimeout(500)
    const draws = await canvas.getAttribute('data-draws')
    await page.waitForTimeout(1000)
    expect(await canvas.getAttribute('data-draws')).toBe(draws)
  }

  test('a hidden tab stops the layout moving and painting', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.goto(GRAPH)
    await hold(page)
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.mouse.up()
    await still(page)
  })

  // Review R7: out of sight (scrolled away, covered), nothing is painted; back in sight it moves again.
  test('R7: a canvas out of sight stops moving and painting', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.goto(GRAPH)
    await hold(page)
    const canvas = page.locator('canvas.graph-canvas')
    await canvas.evaluate((c) => {
      ;(c as HTMLElement).style.transform = 'translateY(4000px)'
    })
    await page.mouse.up()
    await still(page)
    await canvas.evaluate((c) => {
      ;(c as HTMLElement).style.transform = ''
    })
    await settled(page)
  })

  // Review R11: the system asking for less motion, or the theme changed, take effect at once.
  test('R11: reduced motion asked while it moves draws it at rest; a theme change repaints', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.goto(GRAPH)
    await hold(page)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.mouse.up()
    await still(page)
    const canvas = page.locator('canvas.graph-canvas')
    const draws = Number(await canvas.getAttribute('data-draws'))
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light'
    })
    await expect.poll(async () => Number(await canvas.getAttribute('data-draws'))).toBeGreaterThan(draws)
  })
})

// Polish (2026-11-09): the canvas is framed like a panel: coloured corners, and a strip with the numbered
// chip, «GRAPH · <brain> · what your agents know» and «<N> PAGES · <M> LINKS». Graph | List | Filters and the
// Inspector switch sit in that strip. v0.5.0: the Communities panel at the right folds from its header.
test('the canvas is a panel with its strip; the communities fold from their header', async ({
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
  const shown = Number(await page.locator('canvas.graph-canvas').getAttribute('data-items'))
  await expect(strip.locator('.panel-meta')).toHaveText(new RegExp(`^${shown} pages · [\\d,]+ links$`))
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
  // No legend of types any more: one Communities panel, under the strip at the right.
  await expect(page.locator('.graph-legend')).toHaveCount(0)
  const panel = page.locator('.graph-communities')
  await expect(panel).toHaveCount(1)
  const p = (await panel.boundingBox()) as { x: number; y: number; width: number; height: number }
  expect(p.y).toBeGreaterThanOrEqual(s.y + s.height)
  expect(c.x + c.width - (p.x + p.width)).toBeLessThan(32)
  const select = panel.getByRole('checkbox', { name: 'Select all' })
  await expect(select).toBeVisible()
  await panel.locator('summary').click()
  await expect(select).toBeHidden()
  await panel.locator('summary').click()
  await expect(select).toBeVisible()
})

// Review R5, v0.5.0: on a touch screen one finger on the background moves the picture, one finger on a page
// drags it, and two fingers move and pinch the picture.
test.describe('the graph by touch', () => {
  test.use({ hasTouch: true, viewport: { width: 1366, height: 900 } })
  type Finger = { x: number; y: number; id: number }
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

  test('R5: one finger moves the picture or drags a page; two fingers move and pinch it', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.goto(GRAPH)
    await settled(page)
    const b = await canvasBox(page)
    // A spot of bare background in the middle of the picture's room, and a page to watch.
    const all = await items(page)
    const free = (x: number, y: number) => all.every((it) => Math.hypot(it.x - x, it.y - y) > 24)
    let spot = { x: b.width * 0.45, y: b.height * 0.55 }
    for (let dx = 0; dx < 200 && !free(spot.x, spot.y); dx += 7)
      spot = { x: b.width * 0.45 + dx, y: b.height * 0.55 }
    const watched = all.findIndex((it) => it.shown && it.role === 0)
    const where = async () => {
      const it = (await items(page))[watched] as Item
      return [it.x, it.y] as const
    }
    const mx = b.x + spot.x
    const my = b.y + spot.y
    // One finger on the background moves the picture by as much.
    const p0 = await where()
    await fingers(page, [{ x: mx, y: my, id: 1 }], [{ x: mx + 100, y: my + 40, id: 1 }])
    await upToDate(page)
    const p1 = await where()
    expect(Math.abs(p1[0] - p0[0] - 100)).toBeLessThanOrEqual(6)
    expect(Math.abs(p1[1] - p0[1] - 40)).toBeLessThanOrEqual(6)
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
    const p2 = await where()
    expect(Math.abs(p2[0] - (cx + 1.2 * (p1[0] - cx)))).toBeLessThanOrEqual(8)
    expect(Math.abs(p2[1] - (cy + 1.2 * (p1[1] - cy)))).toBeLessThanOrEqual(8)
    // One finger on a page drags it.
    const it = (await items(page))[watched] as Item
    await fingers(
      page,
      [{ x: b.x + it.x, y: b.y + it.y, id: 1 }],
      [{ x: b.x + it.x + 60, y: b.y + it.y + 30, id: 1 }],
    )
    const after = (await items(page))[watched] as Item
    expect(Math.hypot(after.x - it.x, after.y - it.y)).toBeGreaterThan(20)
  })
})
