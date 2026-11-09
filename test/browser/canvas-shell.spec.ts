// Spec canvas-ui CA1 and CA9 (plan B.3, B7): at 1920×1080 every signed-in screen has the rail folded to
// 56px and its content spans at least 90% of the width the rail leaves; opened, the rail is 220px and is
// remembered; its names show as tooltips on keyboard focus and Esc hides them; the brain switcher works by
// keyboard; nothing scrolls sideways at 1366×768, folded or open.
import type { Page } from '@playwright/test'
import { expect, noSideScroll, scenario, test } from './fixture.ts'
import { ROWS } from './screens.ts'

const WIDE = { width: 1920, height: 1080 }
const SMALL = { width: 1366, height: 768 }
const SIGNED_IN = ROWS.filter((r) => !r.preset)

// How wide the content of the screen is drawn: from the leftmost to the rightmost thing that is painted in
// main (words, controls, pictures, and boxes with a ground or a line of their own). A block that is only as
// wide as the page but paints nothing does not count.
async function contentSpan(page: Page): Promise<{ span: number; left: number; right: number }> {
  return page.evaluate(() => {
    const main = document.querySelector('main') as HTMLElement
    let left = Number.POSITIVE_INFINITY
    let right = Number.NEGATIVE_INFINITY
    const take = (r: DOMRect) => {
      if (r.width < 1 || r.height < 1) return
      left = Math.min(left, r.left)
      right = Math.max(right, r.right)
    }
    const painted = (el: Element) => {
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none') return false
      const ground = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent'
      const line = ['Top', 'Right', 'Bottom', 'Left'].some(
        (s) =>
          Number.parseFloat(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)) > 0 &&
          cs.getPropertyValue(`border-${s.toLowerCase()}-style`) !== 'none',
      )
      return ground || line || /^(IMG|SVG|CANVAS|INPUT|SELECT|TEXTAREA|BUTTON|svg)$/.test(el.tagName)
    }
    for (const el of main.querySelectorAll('*')) {
      if (el.closest('dialog:not([open])')) continue
      if (painted(el)) take(el.getBoundingClientRect())
    }
    const walk = document.createTreeWalker(main, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!n.textContent?.trim()) continue
      const parent = n.parentElement
      if (!parent || parent.closest('.sr-only, dialog:not([open])')) continue
      range.selectNodeContents(n)
      for (const r of range.getClientRects()) take(r)
    }
    return { span: right - left, left, right }
  })
}

async function railWidth(page: Page): Promise<number> {
  return page.locator('header.rail').evaluate((el) => el.getBoundingClientRect().width)
}

for (const row of SIGNED_IN) {
  test(`CA1 at 1920×1080, ${row.name}: rail 56px and content over 90% of the rest`, async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.setViewportSize(WIDE)
    await page.goto(row.path)
    if (row.seed) await row.seed(s)
    await expect(row.ready(page)).toBeVisible()
    await page.waitForLoadState('networkidle')
    expect(await railWidth(page)).toBeCloseTo(56, 0)
    const { span } = await contentSpan(page)
    expect(span, `${row.name} spans ${Math.round(span)}px`).toBeGreaterThanOrEqual(0.9 * (WIDE.width - 56))
  })
}

test('opened, the rail is 220px with the names, and stays open after a reload', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.setViewportSize(WIDE)
  await page.goto('/b/growth')
  const nav = page.getByRole('navigation', { name: 'Sections of this brain' })
  await expect(nav.getByRole('link', { name: 'Overview' })).toBeVisible()
  const toggle = page.getByRole('button', { name: 'Expand the side bar' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  // Folded, a name is in the page for screen readers but not drawn.
  expect((await nav.getByText('Wiki', { exact: true }).boundingBox())?.width ?? 0).toBeLessThanOrEqual(1)
  await toggle.click()
  const fold = page.getByRole('button', { name: 'Collapse the side bar' })
  await expect(fold).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(() => railWidth(page)).toBeCloseTo(220, 0)
  await expect(nav.getByText('Wiki', { exact: true })).toBeVisible()
  expect((await nav.getByText('Wiki', { exact: true }).boundingBox())?.width ?? 0).toBeGreaterThan(20)
  await page.reload()
  await expect(nav.getByRole('link', { name: 'Overview' })).toBeVisible()
  expect(await railWidth(page)).toBeCloseTo(220, 0)
  await expect(page.getByRole('button', { name: 'Collapse the side bar' })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  // Closed again, and remembered folded.
  await page.getByRole('button', { name: 'Collapse the side bar' }).click()
  await expect.poll(() => railWidth(page)).toBeCloseTo(56, 0)
  await page.reload()
  await expect(nav.getByRole('link', { name: 'Overview' })).toBeVisible()
  expect(await railWidth(page)).toBeCloseTo(56, 0)
})

test('folded, a name shows as a tooltip on keyboard focus and on hover; Esc hides it', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.setViewportSize(WIDE)
  await page.goto('/b/growth')
  const nav = page.getByRole('navigation', { name: 'Sections of this brain' })
  const wiki = nav.getByRole('link', { name: 'Wiki' })
  const tip = wiki.locator('.rail-label')
  await expect(wiki).toBeVisible()
  const shown = async () => ((await tip.boundingBox())?.width ?? 0) > 20
  // Keyboard: Tab from the link before it.
  await nav.getByRole('link', { name: /^Proposals/ }).focus()
  await page.keyboard.press('Tab')
  await expect(wiki).toBeFocused()
  await expect.poll(shown).toBe(true)
  const box = await tip.boundingBox()
  const rail = await page.locator('header.rail').boundingBox()
  expect(box?.x ?? 0, 'the tooltip is beside the rail, not over it').toBeGreaterThanOrEqual(
    (rail?.x ?? 0) + (rail?.width ?? 0),
  )
  await page.keyboard.press('Escape')
  await expect.poll(shown).toBe(false)
  await expect(wiki).toBeFocused()
  // The next item shows its own.
  await page.keyboard.press('Tab')
  const decisions = nav.getByRole('link', { name: 'Decisions' })
  await expect(decisions).toBeFocused()
  await expect
    .poll(async () => ((await decisions.locator('.rail-label').boundingBox())?.width ?? 0) > 20)
    .toBe(true)
  // Hover.
  await page.locator('main').click({ position: { x: 600, y: 600 } })
  await nav.getByRole('link', { name: 'Graph' }).hover()
  await expect
    .poll(
      async () =>
        ((await nav.getByRole('link', { name: 'Graph' }).locator('.rail-label').boundingBox())?.width ?? 0) >
        20,
    )
    .toBe(true)
  await page.keyboard.press('Escape')
  await expect
    .poll(
      async () =>
        ((await nav.getByRole('link', { name: 'Graph' }).locator('.rail-label').boundingBox())?.width ?? 0) >
        20,
    )
    .toBe(false)
})

test('the brain switcher opens, leads to another brain and closes by keyboard', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.setViewportSize(WIDE)
  await page.goto('/b/growth')
  const switcher = page.getByRole('button', { name: /Growth.*switch brain/ })
  await expect(switcher).toHaveAttribute('aria-expanded', 'false')
  await switcher.focus()
  await page.keyboard.press('Enter')
  await expect(switcher).toHaveAttribute('aria-expanded', 'true')
  const menu = page.locator('#brain-switcher')
  await expect(menu.getByRole('link', { name: 'Growth' })).toHaveAttribute('aria-current', 'page')
  await expect(menu.getByRole('link', { name: 'All brains' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(switcher).toBeFocused()
  await page.keyboard.press('Enter')
  const other = menu.getByRole('link', { name: 'Support' })
  await other.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/b\/support$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Support' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Support.*switch brain/ })).toHaveAttribute(
    'aria-expanded',
    'false',
  )
})

for (const state of ['folded', 'open'] as const) {
  test(`at 1366×768, ${state}, no screen scrolls sideways and the rail's foot is in view`, async ({
    page,
    context,
    baseURL,
  }) => {
    test.slow()
    await context.addInitScript((r) => localStorage.setItem('rscb.rail', r), state)
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.setViewportSize(SMALL)
    for (const row of SIGNED_IN) {
      await page.goto(row.path)
      if (row.seed) await row.seed(s)
      await expect(row.ready(page)).toBeVisible()
      await noSideScroll(page)
      expect(await railWidth(page)).toBeCloseTo(state === 'open' ? 220 : 56, 0)
      const toggle = page.locator('.rail-toggle')
      const box = await toggle.boundingBox()
      expect((box?.y ?? 9999) + (box?.height ?? 0), `${row.name}: the rail's foot fits`).toBeLessThanOrEqual(
        SMALL.height,
      )
    }
  })
}

// B9: the overview of a brain is read at a glance on a wide screen: its figures in one row of tiles, and
// today's sessions, what waits for review and the health side by side.
test('at 1920×1080 the overview shows its figures in one row and its three parts side by side', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.setViewportSize(WIDE)
  await page.goto('/b/growth')
  const parts = ["Today's sessions", 'Waiting for review', 'Health'].map((name) =>
    page.getByRole('region', { name, exact: true }),
  )
  for (const p of parts) await expect(p).toBeVisible()
  const boxes = await Promise.all(parts.map((p) => p.boundingBox()))
  const [today, waiting, health] = boxes.map((b) => b ?? { x: 0, y: 0, width: 0, height: 0 })
  expect(Math.abs((waiting?.y ?? 0) - (today?.y ?? 0)), 'waiting beside today').toBeLessThanOrEqual(2)
  expect(Math.abs((health?.y ?? 0) - (today?.y ?? 0)), 'health beside today').toBeLessThanOrEqual(2)
  expect(today?.x ?? 0).toBeLessThan(waiting?.x ?? 0)
  expect(waiting?.x ?? 0).toBeLessThan(health?.x ?? 0)
  const tiles = page.getByRole('region', { name: 'In numbers' }).getByRole('listitem')
  await expect(tiles).toHaveCount(5)
  const tops = await tiles.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)))
  expect(new Set(tops).size, 'one row of figures').toBe(1)
  const widths = await tiles.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width))
  expect(Math.min(...widths), 'the tiles share the width').toBeGreaterThan(250)
})
