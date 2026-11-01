// Spec B6 «Graph», the second review of PR22: the keyboard is never left waiting for a place that will not
// come; loose pages sit beside the groups and many of them gather into one group; the graph starts above the
// fold with the filters folded into a summary; on a phone the selected page stays above the sheet; focus says
// where it is and how each two-hop page is reached; the list has fewer stops a row and a way past the table;
// an empty wiki points to Proposals; the painter on the page draws when the canvas cannot move to the worker.
import { expect, scenario, test } from './fixture.ts'

const GRAPH = '/b/growth/wiki/graph'
// The filters fold into their summary; a test that sets one opens them first.
const openFilters = async (page: import('@playwright/test').Page) => {
  const box = page.locator('.graph-filters')
  if (!(await box.evaluate((d) => (d as HTMLDetailsElement).open))) await box.locator('summary').click()
}
const settled = (page: import('@playwright/test').Page) =>
  expect(page.locator('canvas.graph-canvas[data-settled]')).toHaveCount(1, { timeout: 20_000 })
const inspectorOf = (page: import('@playwright/test').Page) =>
  page.getByRole('complementary', { name: /^Inspector \S/ })

test('Leave focus never leaves the keyboard waiting for a row that is gone, nor takes it back later', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.goto(`${GRAPH}?view=list`)
  const table = page.getByRole('table', { name: /Pages of the wiki/ })
  await expect(table.locator('tbody tr').first()).toBeVisible()
  // A topic page: a Type filter set during focus leaves its row out of the list.
  const row = table.locator('tbody tr', { hasText: 'Topic' }).first()
  const focusButton = row.locator('[data-focus-for]')
  const address = (await focusButton.getAttribute('data-focus-for')) as string
  await focusButton.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('#graph-focus')).toBeFocused()
  await openFilters(page)
  await page.getByLabel('Type', { exact: true }).selectOption('decision')
  await page.getByRole('button', { name: 'Leave focus' }).focus()
  await page.keyboard.press('Enter')
  // The row is not there: the keyboard lands on the heading of the list instead of nowhere.
  await expect(page.locator('#graph-place')).toBeFocused()
  // Later, the row comes back: the keyboard stays where the person put it.
  const type = page.getByLabel('Type', { exact: true })
  await type.focus()
  await type.selectOption('')
  await expect(page.locator(`[data-focus-for="${address}"]`)).toBeVisible()
  await expect(type).toBeFocused()
})

test('a lumpy wiki: loose pages beside the groups, many gathered as "Other pages", opened by keyboard', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 'lumpy' })
  await page.goto(`${GRAPH}?view=list`)
  const groups = page.getByRole('table', { name: 'Groups of the wiki' })
  await expect(groups.locator('tbody tr')).toHaveCount(3)
  await expect(groups).toContainText('Other pages (100)')
  await page.getByRole('button', { name: 'Open group eng' }).click()
  await expect(page.locator('#graph-place')).toHaveText('Group eng')
  await expect(groups).toContainText('Other pages in eng (60)')
  await page.getByRole('button', { name: 'Open group Other pages in eng (60)' }).click()
  await expect(page).toHaveURL(/loose=1/)
  await expect(page.locator('#graph-place')).toHaveText('Other pages in eng')
  await expect(page.getByRole('table', { name: /Pages of the wiki/ }).getByRole('caption')).toContainText(
    'of 60 pages',
  )
  // In the graph, the same group draws its 60 pages.
  await page.getByRole('button', { name: 'Graph', exact: true }).click()
  await settled(page)
  await expect(page.locator('canvas.graph-canvas')).toHaveAttribute('data-items', /^6\d$/)
})

test('1440 × 900: the graph starts above the fold, the filters fold into a summary, Focus keeps it in view', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${GRAPH}?type=topic`)
  await settled(page)
  await expect(page.getByLabel('Words', { exact: true })).toBeHidden()
  await expect(page.locator('.graph-filters summary')).toContainText('Type: Topic')
  const canvas = page.locator('canvas.graph-canvas')
  const box = await canvas.boundingBox()
  expect(box?.y ?? 999).toBeLessThan(330)
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(900)
  expect(box?.height ?? 0).toBeGreaterThan(400)
  await canvas.focus()
  await page.keyboard.press('Enter')
  await inspectorOf(page).getByRole('button', { name: 'Focus: 2 hops' }).click()
  await expect(page.locator('#graph-place')).toHaveText(/^Focus: .+ · 2 hops · \d+ pages?$/)
  await expect(canvas).toBeInViewport({ ratio: 0.9 })
  expect(await page.evaluate(() => window.scrollY)).toBeLessThan(200)
})

test('375 px: the inspector opens as a peek that expands, and the selected page stays above it', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.setViewportSize({ width: 375, height: 740 })
  await page.goto(GRAPH)
  await settled(page)
  const canvas = page.locator('canvas.graph-canvas')
  await canvas.focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Enter')
  const sheet = inspectorOf(page)
  await expect(sheet).toHaveAttribute('data-sheet', 'peek')
  const top = (await sheet.boundingBox())?.y ?? 0
  const cbox = await canvas.boundingBox()
  // The page under the keyboard is drawn above the top of the sheet.
  await expect
    .poll(async () => {
      const [, y] = ((await canvas.getAttribute('data-active')) ?? '0,9999').split(',').map(Number)
      return (cbox?.y ?? 0) + (y ?? 9999)
    })
    .toBeLessThan(top)
  await sheet.getByRole('button', { name: 'More' }).click()
  await expect(sheet).toHaveAttribute('data-sheet', 'full')
})

test('focus in the list: two-hop rows say which neighbour they come through; one stop and a menu a row', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto(`${GRAPH}?view=list&focus=audience%2Fretention&hops=2`)
  await expect(page.getByRole('heading', { level: 1, name: 'Graph' })).toBeVisible()
  await expect(page.locator('#graph-place')).toHaveText(/^Focus: Retention · 2 hops · \d+ pages$/)
  const table = page.getByRole('table', { name: 'Retention and its neighbours' })
  const two = table.locator('tbody tr', { hasText: '2 hops' }).first()
  await expect(two).toContainText('via ')
  // The row's actions take one Tab stop; the arrow keys move between them.
  const first = table.locator('tbody tr').nth(1)
  const actions = first.locator('.row-actions button')
  await actions.first().focus()
  await page.keyboard.press('ArrowRight')
  await expect(actions.nth(1)).toBeFocused()
  expect(await first.locator('[tabindex="0"], a[href], button:not([tabindex="-1"])').count()).toBe(2)
})

test('the list has a way past the table to its pages', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.goto(`${GRAPH}?view=list`)
  const skip = page.getByRole('button', { name: 'Skip to the page buttons' })
  await expect(skip).toHaveCount(1)
  await skip.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('#graph-pager')).toBeFocused()
})

test('tags filter as they are typed', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto(GRAPH)
  await settled(page)
  await page.locator('.graph-filters summary').click()
  await openFilters(page)
  await page.getByLabel('Tag', { exact: true }).pressSequentially('q4')
  await expect(page).toHaveURL(/tag=q4/)
})

test('an empty wiki points to Proposals, and with words says no pages match', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', { graph: 'empty', pages: 'empty' })
  await page.goto(`${GRAPH}?view=list`)
  const main = page.getByRole('main')
  await expect(main).toContainText('Pages arrive when agents propose them and a curator approves')
  await expect(main.getByRole('link', { name: 'Proposals' })).toBeVisible()
  await expect(main.locator('[data-state="empty"]')).not.toContainText(/graph/i)
  await page.goto(`${GRAPH}?view=list&q=zebra`)
  await expect(page.getByText('No pages match')).toBeVisible()
})

test('without OffscreenCanvas the page paints the graph itself', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.addInitScript(() => {
    // The method is removed so the painter on the page runs.
    delete (HTMLCanvasElement.prototype as { transferControlToOffscreen?: unknown })
      .transferControlToOffscreen
  })
  await page.goto(GRAPH)
  await settled(page)
  const canvas = page.locator('canvas.graph-canvas')
  await expect.poll(async () => Number(await canvas.getAttribute('data-draws'))).toBeGreaterThan(0)
  // Painted pixels: the canvas is not blank.
  const inked = await canvas.evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')?.getImageData(0, 0, c.width, c.height).data
    let n = 0
    if (d) for (let i = 3; i < d.length; i += 4) if ((d[i] as number) > 0) n++
    return n
  })
  expect(inked).toBeGreaterThan(100)
})

test('Focus from the list on a page inside a group not open: the group opens and the keyboard lands on the focus bar', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 'lumpy' })
  // One level down, two levels down, and among the pages gathered inside a group.
  for (const [q, address, group] of [
    ['deal-3', 'sales/deal-3', 'sales'],
    ['backend/s-1234', 'eng/backend/s-1234', 'eng%2Fbackend'],
    ['note-7', 'eng/note-7', 'eng'],
  ] as const) {
    await page.goto(`${GRAPH}?view=list&q=${encodeURIComponent(q)}`)
    const button = page.locator(`[data-focus-for="${address}"]`)
    await button.focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`group=${group}(&|$)`))
    await expect(page.locator('#graph-focus')).toBeFocused()
  }
})
