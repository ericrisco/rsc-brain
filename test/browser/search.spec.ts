// Spec B6 «Search» (PR23, T039): ⌘K or Ctrl K from anywhere searches the current brain or all of mine; each
// result says why it is there; filters at the side, in a panel on a phone; with no results it suggests
// removing the filters or searching all; Enter opens and Esc goes back, with the keyboard where it was.
import { expect, noSideScroll, scenario, test } from './fixture.ts'

const dialog = (page: import('@playwright/test').Page) => page.getByRole('dialog', { name: 'Search' })

test('inside a brain it searches that brain; each result says why', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth')
  await expect(page.getByRole('heading', { level: 1, name: 'Growth' })).toBeVisible()
  const asked: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('/v1/search')) asked.push(r.url())
  })
  await page.keyboard.press('Control+k')
  const d = dialog(page)
  await expect(d.getByLabel('Search for')).toBeFocused()
  await expect(d.getByRole('radio', { name: 'This brain (Growth)' })).toBeChecked()
  await d.getByLabel('Search for').fill('intro')
  await d.getByLabel('Search for').press('Enter')
  const results = d.getByRole('list', { name: 'Results' }).getByRole('listitem')
  await expect(results.first()).toBeVisible()
  await expect(results.first()).toContainText('matched by words')
  expect(asked.at(-1)).toContain('brains=growth')
  await d.getByRole('radio', { name: 'All my brains' }).check()
  await expect.poll(() => asked.at(-1) ?? '').not.toContain('brains=')
})

test('Enter opens a result; the arrows move between results', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth')
  await expect(page.getByRole('heading', { level: 1, name: 'Growth' })).toBeVisible()
  await page.keyboard.press('Control+k')
  const d = dialog(page)
  await d.getByLabel('Search for').fill('retention')
  await d.getByLabel('Search for').press('Enter')
  const first = d.getByRole('list', { name: 'Results' }).getByRole('link').first()
  await expect(first).toBeVisible()
  await d.getByLabel('Search for').press('ArrowDown')
  await expect(first).toBeFocused()
  const href = await first.getAttribute('href')
  await page.keyboard.press('Enter')
  await expect(d).toBeHidden()
  await expect(page).toHaveURL(new RegExp(`${href?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
})

test('Esc goes back, with the keyboard where it was', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth')
  const link = page
    .getByRole('navigation', { name: 'Sections of this brain' })
    .getByRole('link', { name: 'Journal' })
  await link.focus()
  await page.keyboard.press('Control+k')
  await expect(dialog(page)).toBeVisible()
  await dialog(page).getByLabel('Search for').fill('retention')
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toBeHidden()
  await expect(link).toBeFocused()
  // Also from a result.
  await page.keyboard.press('Control+k')
  await dialog(page).getByLabel('Search for').press('Enter')
  await dialog(page).getByLabel('Search for').press('ArrowDown')
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toBeHidden()
  await expect(link).toBeFocused()
})

test('Ctrl K works while typing in a field; letters do not', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth/journal')
  const field = page.getByLabel('External reference')
  await page.locator('summary').filter({ hasText: 'Filter the sessions' }).click()
  await field.fill('g j')
  await expect(page).toHaveURL(/\/journal$/)
  await field.press('Control+k')
  await expect(dialog(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(field).toBeFocused()
})

test('no results: remove the filters, or search all my brains', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth')
  await expect(page.getByRole('heading', { level: 1, name: 'Growth' })).toBeVisible()
  await page.keyboard.press('Control+k')
  const d = dialog(page)
  await d.getByLabel('Written or changed since').fill('2030-01-01')
  await d.getByLabel('Search for').fill('retention')
  await d.getByLabel('Search for').press('Enter')
  await expect(d.getByText('Nothing found for "retention".')).toBeVisible()
  await expect(d.getByText('The filters may be hiding it.')).toBeVisible()
  await d.getByRole('button', { name: 'Remove the filters' }).click()
  await expect(d.getByRole('list', { name: 'Results' }).getByRole('listitem').first()).toBeVisible()
  await d.getByLabel('Search for').fill('zzz-nothing')
  await d.getByLabel('Search for').press('Enter')
  await expect(d.getByText('It may be in another brain')).toBeVisible()
  await d.getByRole('button', { name: 'Search all my brains' }).click()
  await expect(d.getByRole('radio', { name: 'All my brains' })).toBeChecked()
  await expect(d.getByRole('button', { name: 'Search all my brains' })).toHaveCount(0)
})

test('on a phone the filters are in a panel; nothing scrolls sideways at 320 px', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto('/b/growth')
  await page.getByRole('button', { name: 'Search' }).first().click()
  const d = dialog(page)
  await expect(d.getByLabel('Type')).toBeHidden()
  await d.getByRole('button', { name: 'Filters' }).click()
  await expect(d.getByLabel('Type')).toBeVisible()
  await d.getByLabel('Type').selectOption('guide')
  await d.getByRole('button', { name: 'Hide filters' }).click()
  await expect(d.getByRole('button', { name: 'Filters (1)' })).toBeVisible()
  await d.getByLabel('Search for').fill('intro')
  await d.getByLabel('Search for').press('Enter')
  await expect(d.getByRole('list', { name: 'Results' }).getByRole('listitem').first()).toBeVisible()
  await noSideScroll(page)
})

test('outside a brain it searches all my brains; much data shows more on request', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', { search: 'much-data' })
  await page.goto('/')
  await page.keyboard.press('Control+k')
  const d = dialog(page)
  await expect(d.getByRole('radio')).toHaveCount(0)
  await d.getByLabel('Search for').fill('intro')
  await d.getByLabel('Search for').press('Enter')
  const results = d.getByRole('list', { name: 'Results' }).getByRole('listitem')
  await expect(results).toHaveCount(20)
  await d.getByRole('button', { name: 'Show more results' }).click()
  await expect(results.nth(20)).toBeVisible()
})

test('an error says what happened and keeps the words', async ({ page, context, baseURL }) => {
  const s = await scenario(context, baseURL as string, 'signed-in', { search: 'error' })
  await page.goto('/')
  await page.keyboard.press('Control+k')
  const d = dialog(page)
  await d.getByLabel('Search for').fill('retention')
  await d.getByLabel('Search for').press('Enter')
  await expect(d.getByRole('alert')).toContainText('Something went wrong on the server')
  await expect(d.getByLabel('Search for')).toHaveValue('retention')
  await s.state('search', 'normal')
  await d.getByRole('button', { name: 'Try again' }).click()
  await expect(d.getByRole('list', { name: 'Results' })).toBeVisible()
})

// Review of PR23.
test('«Show more» pages the words that were searched, not what the field says now', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in', { search: 'much-data' })
  await page.goto('/')
  await page.keyboard.press('Control+k')
  const d = dialog(page)
  await d.getByLabel('Search for').fill('intro')
  await d.getByLabel('Search for').press('Enter')
  await expect(d.getByRole('list', { name: 'Results' }).getByRole('listitem')).toHaveCount(20)
  const asked: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('/v1/search')) asked.push(r.url())
  })
  await d.getByLabel('Search for').fill('something else')
  await d.getByRole('button', { name: 'Show more results' }).click()
  await expect.poll(() => asked.length).toBe(1)
  expect(asked[0]).toContain('q=intro')
  expect(asked[0]).toContain('offset=20')
})

test('reopened in another brain, the old results are gone', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth')
  await expect(page.getByRole('heading', { level: 1, name: 'Growth' })).toBeVisible()
  await page.keyboard.press('Control+k')
  await dialog(page).getByLabel('Search for').fill('intro')
  await dialog(page).getByLabel('Search for').press('Enter')
  await expect(dialog(page).getByRole('list', { name: 'Results' })).toBeVisible()
  await page.keyboard.press('Escape')
  // Moving inside the web (no reload): the dialog keeps its state, so the old answer must go.
  await page.getByRole('link', { name: '← All brains' }).click()
  await page.getByRole('link', { name: 'Support' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Support' })).toBeVisible()
  await page.keyboard.press('Control+k')
  await expect(dialog(page).getByRole('radio', { name: 'This brain (Support)' })).toBeChecked()
  await expect(dialog(page).getByRole('list', { name: 'Results' })).toHaveCount(0)
})

test('a filter changed while a search is on its way runs; the older answer never lands', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth')
  await expect(page.getByRole('heading', { level: 1, name: 'Growth' })).toBeVisible()
  // The first answer is slow; the second fast.
  let n = 0
  await page.route('**/v1/search?*', async (route) => {
    n += 1
    if (n === 2) await new Promise((r) => setTimeout(r, 1_500))
    await route.continue()
  })
  await page.keyboard.press('Control+k')
  const d = dialog(page)
  await d.getByLabel('Search for').fill('retention')
  await d.getByLabel('Search for').press('Enter')
  await expect(d.getByRole('list', { name: 'Results' })).toBeVisible()
  await d.getByLabel('Show').selectOption('entries')
  await d.getByLabel('Show').selectOption('pages')
  await page.waitForTimeout(2_000)
  const kinds = await d.getByRole('list', { name: 'Results' }).getByRole('listitem').allTextContents()
  expect(kinds.length).toBeGreaterThan(0)
  for (const k of kinds) expect(k).toContain('Wiki page')
})

test('snippets highlight what matched and show no markdown; Type follows what is shown', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth')
  await expect(page.getByRole('heading', { level: 1, name: 'Growth' })).toBeVisible()
  await page.keyboard.press('Control+k')
  const d = dialog(page)
  await d.getByLabel('Search for').fill('retention')
  await d.getByLabel('Search for').press('Enter')
  await expect(d.getByRole('list', { name: 'Results' }).locator('mark').first()).toBeVisible()
  await expect(d.getByRole('list', { name: 'Results' })).not.toContainText('«')
  await expect(d.getByRole('list', { name: 'Results' })).not.toContainText('[[')
  await expect(d.getByRole('list', { name: 'Results' })).not.toContainText('##')
  await d.getByLabel('Show').selectOption('pages')
  const types = await d.getByLabel('Type').locator('option').allTextContents()
  expect(types).not.toContain('Learning')
  expect(types).toContain('Topic')
})

test('on a phone the filters open right below their button, without moving what is above', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.setViewportSize({ width: 375, height: 740 })
  await page.goto('/b/growth')
  await page.getByRole('button', { name: 'Search' }).first().click()
  const d = dialog(page)
  const toggle = d.getByRole('button', { name: 'Filters' })
  const before = await toggle.boundingBox()
  await toggle.click()
  const after = await d.getByRole('button', { name: 'Hide filters' }).boundingBox()
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(2)
  const panel = await d.getByLabel('Show').boundingBox()
  expect(panel?.y ?? 0).toBeGreaterThan((after?.y ?? 0) + (after?.height ?? 0) - 1)
})

test('new words sent while a search is on its way replace it; old answers never show under new words', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth')
  await expect(page.getByRole('heading', { level: 1, name: 'Growth' })).toBeVisible()
  let n = 0
  await page.route('**/v1/search?*', async (route) => {
    n += 1
    if (n === 1) await new Promise((r) => setTimeout(r, 1_500))
    await route.continue()
  })
  await page.keyboard.press('Control+k')
  const d = dialog(page)
  await d.getByLabel('Search for').fill('retention')
  await d.getByLabel('Search for').press('Enter')
  await d.getByLabel('Search for').fill('zzz-nothing-at-all')
  await d.getByLabel('Search for').press('Enter')
  await expect(d.getByText('Nothing found for "zzz-nothing-at-all".')).toBeVisible()
  await page.waitForTimeout(1_800)
  await expect(d.getByRole('list', { name: 'Results' })).toHaveCount(0)
  expect(n).toBe(2)
})
