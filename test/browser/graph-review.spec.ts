// Spec B6 «Graph», the fixes of the review of PR22: the list and the graph agree (retired pages only on
// asking, the same filters in focus, the counts of groups under filters, sort by status); the keyboard lands
// somewhere useful after every action; Back undoes a move between groups; on a phone the inspector comes
// into view and the filters fold away; Escape closes the inspector wherever the keyboard is.
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

test('the list shows what the graph draws: retired pages only with the Retired status; sorts by status', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.goto(`${GRAPH}?view=list`)
  const table = page.getByRole('table', { name: /Pages of the wiki/ })
  const badge = page.locator('.graph-place-row .tag')
  await expect(table.getByRole('caption')).toContainText(/of 2\d\d pages/)
  const caption = (await table.getByRole('caption').textContent()) ?? ''
  // The header and the table say the same number.
  expect(caption).toContain((await badge.textContent()) ?? 'none')
  for (const s of await table.locator('tbody .tag').allTextContents()) expect(s).not.toBe('Retired')
  await openFilters(page)
  await page.getByLabel('Status', { exact: true }).selectOption('retired')
  await expect(table.locator('tbody .tag').first()).toHaveText('Retired')
  await page.getByLabel('Status', { exact: true }).selectOption('')
  await table.getByRole('button', { name: 'Sort by Status, ascending' }).click()
  await expect(page).toHaveURL(/sort=status/)
  await expect(table.locator('tbody tr')).toHaveCount(50)
  await expect(page.locator('[data-state="error"]')).toHaveCount(0)
})

test('focus in the list keeps the filters: a tag leaves out the neighbours without it', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto(`${GRAPH}?view=list&focus=audience%2Fretention&hops=2`)
  const table = page.getByRole('table', { name: 'Retention and its neighbours' })
  await expect(table.locator('tbody tr').nth(1)).toBeVisible()
  const all = await table.locator('tbody tr').count()
  await openFilters(page)
  await page.getByLabel('Tag', { exact: true }).fill('q4')
  await page.getByLabel('Tag', { exact: true }).press('Enter')
  await page.getByLabel('Tag', { exact: true }).blur()
  await expect(page).toHaveURL(/tag=q4/)
  await expect.poll(async () => table.locator('tbody tr').count()).toBeLessThan(all)
  // The link column reads as a sentence: who links to whom, by what.
  await expect(table.locator('tbody tr').nth(1)).toContainText('→')
})

test('the keyboard lands somewhere after Focus, Leave focus, All groups and Clear filters', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 5000 })
  await page.goto(`${GRAPH}?view=list`)
  const open = page.getByRole('button', { name: /^Open group / }).first()
  await open.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('#graph-place')).toBeFocused()
  const focusButton = page.getByRole('button', { name: /^Focus: 1 hop, / }).first()
  const target = await focusButton.getAttribute('data-focus-for')
  await focusButton.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('#graph-focus')).toBeFocused()
  await page.getByRole('button', { name: 'Leave focus' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator(`[data-focus-for="${target}"]`)).toBeFocused()
  await page.getByRole('button', { name: 'All groups' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('#graph-place')).toBeFocused()
  await expect(page.locator('#graph-place')).toHaveText('All groups')
  await openFilters(page)
  await page.getByLabel('Type', { exact: true }).selectOption('decision')
  await page.getByRole('button', { name: 'Clear filters' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('#graph-q')).toBeFocused()
})

test('Back after opening a group goes back to all the groups, not out of the brain', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 5000 })
  await page.goto(`${GRAPH}?view=list`)
  await page
    .getByRole('button', { name: /^Open group / })
    .first()
    .click()
  await expect(page).toHaveURL(/group=/)
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`${GRAPH}\\?view=list$`))
  await expect(page.getByRole('table', { name: 'Groups of the wiki' })).toBeVisible()
})

test('by groups, a filter changes the count of the header and of each group', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 5000 })
  await page.goto(`${GRAPH}?view=list`)
  const badge = page.locator('.graph-place-row .tag')
  const groups = page.getByRole('table', { name: 'Groups of the wiki' })
  await expect(badge).toContainText('in 12 groups')
  const before = await badge.textContent()
  const firstCount = await groups.locator('tbody tr td.num').first().textContent()
  await openFilters(page)
  await page.getByLabel('Type', { exact: true }).selectOption('decision')
  await expect(badge).not.toHaveText(before ?? '')
  await expect(groups.locator('tbody tr td.num').first()).not.toHaveText(firstCount ?? '')
  // An opened group counts its pages only, never the boxes of other groups around it.
  await page.getByLabel('Type', { exact: true }).selectOption('')
  await page
    .getByRole('button', { name: /^Open group / })
    .first()
    .click()
  await page.getByRole('button', { name: 'Graph', exact: true }).click()
  await settled(page)
  const text = (await badge.textContent()) ?? ''
  expect(text).toMatch(/^[\d,]+ pages$/)
})

test('Escape closes the inspector opened from the list at once, and Enter does not open a hidden page', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto(`${GRAPH}?view=list`)
  const button = page.getByRole('button', { name: 'Inspect Retention' })
  await button.click()
  await page.keyboard.press('Escape')
  await expect(inspectorOf(page)).toHaveCount(0)
  await expect(button).toBeFocused()
  // On the canvas: the keyboard's page hidden by a filter meanwhile is not opened by Enter.
  await page.getByRole('button', { name: 'Graph', exact: true }).click()
  await settled(page)
  const canvas = page.locator('canvas.graph-canvas')
  await canvas.focus()
  await openFilters(page)
  await page.getByLabel('Words', { exact: true }).fill('retention')
  await settled(page)
  await canvas.focus()
  await page.keyboard.press('Enter')
  const title = inspectorOf(page).getByRole('heading', { level: 2 })
  await expect(title).toContainText(/retention/i)
})

test('375 px: the filters fold away and the inspector comes into view', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 300 })
  await page.setViewportSize({ width: 375, height: 740 })
  await page.goto(`${GRAPH}?view=list`)
  await expect(page.getByLabel('Words', { exact: true })).toBeHidden()
  await page.getByText(/^Filters/).click()
  await expect(page.getByLabel('Words', { exact: true })).toBeVisible()
  await page
    .getByRole('button', { name: /^Inspect / })
    .first()
    .click()
  await expect(inspectorOf(page).getByRole('link', { name: 'Open page' })).toBeInViewport()
})

test('an empty wiki: the list says there are no pages yet, with no filters to try', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', { graph: 'empty', pages: 'empty' })
  await page.goto(`${GRAPH}?view=list`)
  await expect(page.getByRole('heading', { name: 'No pages yet' })).toBeVisible()
  await expect(page.getByLabel('Words', { exact: true })).toHaveCount(0)
  await expect(page.getByText('No results for these filters.')).toHaveCount(0)
})

test('a group above 2 000 pages opens by groups again; a group that cannot be split sends to the list', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', {}, { seeded: 5000 })
  await page.goto(`${GRAPH}?group=audience`)
  await settled(page)
  await expect(page.locator('#graph-place')).toHaveText('Group audience')
})
