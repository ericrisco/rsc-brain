// Spec B6 «Graph» (PR22, T032–T033): the graph of a wiki on a canvas and its list, against the fixture API in
// CI. The keyboard reaches everything: the canvas walks linked pages with the arrows and opens the inspector
// with Enter; the list does all the inspector does (CA5), and the groups of a big wiki too. Every state is
// drawn. The timings (CA5, CA6) and reduced motion (CA7) are in graph-perf.spec.ts.
import { expect, noSideScroll, scenario, test } from './fixture.ts'

const GRAPH = '/b/growth/wiki/graph'
// The filters fold into their summary; a test that sets one opens them first.
const openFilters = async (page: import('@playwright/test').Page) => {
  const box = page.locator('.graph-filters')
  if (!(await box.evaluate((d) => (d as HTMLDetailsElement).open))) await box.locator('summary').click()
}
const settled = (page: import('@playwright/test').Page) =>
  expect(page.locator('canvas.graph-canvas[data-settled]')).toHaveCount(1, { timeout: 20_000 })

test.describe('the graph', () => {
  test('the side bar leads to it; the canvas is reached and walked by keyboard alone', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth')
    await page
      .getByRole('navigation', { name: 'Sections of this brain' })
      .getByRole('link', { name: 'Graph' })
      .click()
    await expect(page).toHaveURL(new RegExp(`${GRAPH}$`))
    await expect(page.getByRole('heading', { level: 1, name: 'Graph' })).toBeFocused()
    await settled(page)
    const canvas = page.getByRole('application', { name: /^Graph of \d+ items$/ })
    await canvas.focus()
    // The keyboard starts on a page and says which.
    const said = page.locator('[aria-live="polite"]').filter({ hasText: /Enter to inspect/ })
    await expect(said).toHaveCount(1)
    const first = await said.textContent()
    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) await page.keyboard.press(key)
    await expect(said).toHaveCount(1)
    await page.keyboard.press('Enter')
    const inspector = page.getByRole('complementary', { name: /^Inspector \S/ })
    await expect(inspector).toBeVisible()
    await expect(inspector.getByRole('link', { name: 'Open page' })).toBeVisible()
    // The canvas keeps the keyboard: Escape closes the inspector from there.
    await expect(canvas).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(inspector).toHaveCount(0)
    expect(first).toBeTruthy()
  })

  test('focus at one and two hops from the inspector, kept in the address', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(GRAPH)
    await settled(page)
    await page.getByRole('button', { name: 'List' }).click()
    await expect(page.getByRole('table', { name: /Pages of the wiki/ })).toBeVisible()
    await page.getByRole('button', { name: 'Inspect Retention' }).click()
    const inspector = page.getByRole('complementary', { name: /^Inspector \S/ })
    await expect(inspector.getByRole('heading', { level: 2, name: 'Retention' })).toBeFocused()
    await expect(inspector.getByText('What keeps viewers watching.')).toBeVisible()
    await inspector.getByRole('button', { name: 'Focus: 2 hops' }).click()
    await expect(page).toHaveURL(/focus=audience%2Fretention/)
    await expect(page).toHaveURL(/hops=2/)
    await expect(page.getByRole('table', { name: 'Retention and its neighbours' })).toBeVisible()
    await page.getByRole('button', { name: '1 hop', exact: true }).click()
    await expect(page).not.toHaveURL(/hops=2/)
    await page.getByRole('button', { name: 'Graph' }).click()
    await settled(page)
    await page.getByRole('button', { name: 'Leave focus' }).click()
    await expect(page).not.toHaveURL(/focus=/)
  })

  test('filters by type, status, link kind, tag and words; nothing left says so and clears', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(GRAPH)
    await settled(page)
    const count = page.locator('.graph-place-row .tag')
    const all = await count.textContent()
    await openFilters(page)
    await page.getByLabel('Type', { exact: true }).selectOption('decision')
    await expect(page).toHaveURL(/type=decision/)
    await expect(count).not.toHaveText(all ?? '')
    await page.getByLabel('Link kind', { exact: true }).selectOption('contradicts')
    await page.getByLabel('Words', { exact: true }).fill('zzzz-nothing')
    await expect(page.getByText('No results for these filters.')).toBeVisible()
    await page.getByRole('button', { name: 'Clear filters' }).first().click()
    await expect(page).not.toHaveURL(/type=|q=|linkKind=/)
    await settled(page)
  })

  test('a click on a page opens it in the inspector; a drag moves the picture instead', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto(GRAPH)
    await settled(page)
    const canvas = page.locator('canvas.graph-canvas')
    await canvas.focus()
    await page.keyboard.press('Enter')
    const heading = page
      .getByRole('complementary', { name: /^Inspector \S/ })
      .getByRole('heading', { level: 2 })
    const title = await heading.textContent()
    await page.keyboard.press('Escape')
    // The inspector gone, the canvas is wider and drawn again: then the place is read.
    await expect(page.getByRole('complementary', { name: /^Inspector \S/ })).toHaveCount(0)
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    await expect(canvas).toHaveAttribute('data-active', /\d+,\d+/)
    const [x, y] = ((await canvas.getAttribute('data-active')) ?? '').split(',').map(Number)
    await canvas.click({ position: { x: x as number, y: y as number } })
    await expect(heading).toHaveText(title ?? '')
    await page.keyboard.press('Escape')
    // A drag from the middle of the picture (its corners hold the canvas's controls).
    const size = (await canvas.boundingBox()) as { x: number; y: number; width: number; height: number }
    await canvas.hover({ position: { x: size.width / 2, y: size.height / 2 } })
    await page.mouse.down()
    await page.mouse.move(size.x + size.width / 2 + 100, size.y + size.height / 2 + 140, { steps: 4 })
    await page.mouse.up()
    await expect(page.getByRole('complementary', { name: /^Inspector \S/ })).toHaveCount(0)
  })
})

test.describe('the list (CA5: everything the graph does, by keyboard)', () => {
  test('300 pages: sorted and filtered, by pages, each with inspect, open and focus', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
    await page.goto(`${GRAPH}?view=list`)
    const table = page.getByRole('table', { name: /Pages of the wiki/ })
    await expect(table.getByRole('caption')).toContainText('1–50 of 282 pages')
    await expect(table.locator('tbody tr')).toHaveCount(50)
    // Sort by links in, the most first: by keyboard.
    await table.getByRole('button', { name: 'Sort by Links in, ascending' }).focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/sort=in/)
    await table.getByRole('button', { name: 'Sort by Links in, descending' }).click()
    await expect(page).toHaveURL(/sort=-in/)
    await expect(table.getByRole('columnheader', { name: /Links in/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    )
    const ins = await table.locator('tbody tr td.num:nth-of-type(4)').allTextContents()
    const nums = ins.map(Number)
    expect([...nums].sort((a, b) => b - a)).toEqual(nums)
    // The next page, and back.
    await page.getByRole('button', { name: 'Next' }).click()
    await expect(table.getByRole('caption')).toContainText('51–100 of 282 pages')
    await page.getByRole('button', { name: 'Previous' }).click()
    await expect(table.getByRole('caption')).toContainText('1–50 of 282 pages')
    // Filtered the same way as the graph.
    await openFilters(page)
    await page.getByLabel('Type', { exact: true }).selectOption('decision')
    await expect(table.getByRole('caption')).not.toContainText('of 282 pages')
    for (const cell of await table.locator('tbody tr td:nth-of-type(2)').allTextContents())
      expect(cell).toBe('Decision')
    // Every action of the inspector is on the row: inspect, open the page, focus.
    const row = table.locator('tbody tr').first()
    await expect(row.getByRole('link')).toHaveAttribute('href', /\/b\/growth\/pages\//)
    await row.getByRole('button', { name: /^Inspect / }).click()
    const inspector = page.getByRole('complementary', { name: /^Inspector \S/ })
    await expect(inspector.getByRole('link', { name: 'Open page' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(inspector).toHaveCount(0)
    await expect(row.getByRole('button', { name: /^Inspect / })).toBeFocused()
  })

  test('5 000 pages: the groups open one by one from the list too; the list stays whole', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 5000 })
    await page.goto(`${GRAPH}?view=list`)
    const groups = page.getByRole('table', { name: 'Groups of the wiki' })
    await expect(groups.locator('tbody tr')).toHaveCount(12)
    await expect(page.getByRole('table', { name: /Pages of the wiki/ }).getByRole('caption')).toContainText(
      'of 4,728 pages',
    )
    const open = groups.getByRole('button', { name: /^Open group / }).first()
    const name = ((await open.getAttribute('aria-label')) ?? '').replace('Open group ', '')
    await open.focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`group=${name}`))
    await expect(page.getByRole('navigation', { name: 'Where you are in the graph' })).toContainText(name)
    await expect(
      page
        .getByRole('table', { name: /Pages of the wiki/ })
        .locator('tbody tr')
        .first(),
    ).toContainText(`${name}/`)
    await page.getByRole('button', { name: 'All groups' }).click()
    await expect(groups).toBeVisible()
  })
})

test.describe('states', () => {
  test('loading, empty, error and no permission are each drawn', async ({ page, context, baseURL }) => {
    const s = await scenario(context, baseURL as string, 'signed-in', { graph: 'empty' })
    await page.goto(GRAPH)
    await expect(page.getByRole('heading', { name: 'Nothing to draw yet' })).toBeVisible()
    await page.getByRole('button', { name: 'Open the list' }).click()
    await expect(page).toHaveURL(/view=list/)
    await s.state('graph', 'error')
    await page.goto(GRAPH)
    await expect(page.locator('[data-state="error"]')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
    await s.state('graph', 'forbidden')
    await page.goto(GRAPH)
    await expect(page.locator('[data-state="forbidden"]')).toBeVisible()
    await s.state('graph', 'loading')
    await page.goto(GRAPH)
    await expect(page.locator('.graph-box.loading')).toBeVisible()
  })

  test('a huge wiki says it is drawn by groups; a group opens from the canvas by keyboard', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 5000 })
    await page.goto(GRAPH)
    await expect(page.getByText(/This wiki has [\d,]+ pages, so it is drawn by groups/)).toBeVisible()
    await settled(page)
    await page.locator('canvas.graph-canvas').focus()
    await page.keyboard.press('Enter')
    const inspector = page.getByRole('complementary', { name: /^Inspector \S/ })
    await inspector.getByRole('button', { name: 'Open group' }).click()
    await expect(page).toHaveURL(/group=/)
    await settled(page)
    await expect(page.getByRole('application', { name: /^Graph of \d+ items$/ })).toBeVisible()
  })

  for (const width of [320, 375]) {
    test(`${width} px: no sideways scroll outside the graph and the tables`, async ({
      page,
      context,
      baseURL,
    }) => {
      await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
      await page.setViewportSize({ width, height: 740 })
      await page.goto(GRAPH)
      await settled(page)
      await noSideScroll(page)
      await page.getByRole('button', { name: 'List' }).click()
      await expect(page.getByRole('table', { name: /Pages of the wiki/ })).toBeVisible()
      await noSideScroll(page)
    })
  }
})
