import type { Route } from '@playwright/test'
import { expect, scenario, test } from './fixture.ts'

test.beforeEach(async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth')
  await expect(page.getByRole('heading', { level: 1, name: 'Growth' })).toBeVisible()
  await page.locator('html[data-keys="on"]').waitFor({ state: 'attached' })
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog', { name: 'Search' })).toBeVisible()
  // Time advances only when the test asks, so the scope can change inside the typing pause.
  await page.clock.install({ time: new Date('2026-11-24T12:00:00Z') })
  await page.clock.pauseAt(new Date('2026-11-24T12:01:00Z'))
})

test('changing scope during the first typing pause sends only the displayed scope', async ({ page }) => {
  const d = page.getByRole('dialog', { name: 'Search' })
  const requests: (string | null)[] = []
  await page.route('**/v1/search?*', async (route) => {
    requests.push(new URL(route.request().url()).searchParams.get('brains'))
    await route.continue()
  })
  await d.getByLabel('Search for').fill('retention')
  await page.clock.runFor(50)
  await d.getByRole('radio', { name: 'All my brains' }).check()
  await page.clock.runFor(500)
  await expect(d.getByRole('list', { name: 'Results' })).toBeVisible()
  expect(requests).toEqual([null])
})

test('closing during the typing pause sends no search', async ({ page }) => {
  const d = page.getByRole('dialog', { name: 'Search' })
  const sent: string[] = []
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/v1/search') sent.push(r.url())
  })
  await d.getByLabel('Search for').fill('retention')
  await page.clock.runFor(50)
  await d.getByLabel('Search for').press('Escape')
  await expect(d).toBeHidden()
  await page.clock.runFor(500)
  expect(sent).toEqual([])
})

test('changing a filter replaces an unanswered first request; clearing drops its later answer', async ({
  page,
}) => {
  const d = page.getByRole('dialog', { name: 'Search' })
  const field = d.getByLabel('Search for')
  const held: Route[] = []
  await page.route('**/v1/search?*', (route) => {
    held.push(route)
  })
  await field.fill('retention')
  await field.press('Enter')
  await expect.poll(() => held.length).toBe(1)
  await d.getByLabel('Show', { exact: true }).selectOption('pages')
  await page.clock.runFor(500)
  await expect.poll(() => held.length).toBe(2)
  const [original, filtered] = held as [Route, Route]
  expect(new URL(filtered.request().url()).searchParams.get('in')).toBe('pages')
  // The superseded error cannot take over while the filtered request is still pending.
  const firstFinished = page.waitForEvent('requestfinished', (r) => r === original.request())
  await original.fulfill({ status: 500, json: {} })
  await firstFinished
  await page.clock.runFor(100)
  await expect(d.getByRole('alert')).toHaveCount(0)
  await field.fill('')
  const lastFinished = page.waitForEvent('requestfinished', (r) => r === filtered.request())
  await filtered.fulfill({ json: { items: [], next: null } })
  await lastFinished
  await page.clock.runFor(500)
  await expect(d.getByText(/Nothing found for/)).toHaveCount(0)
  await expect(d.getByRole('button', { name: 'Search', exact: true })).not.toHaveAttribute(
    'aria-busy',
    'true',
  )
  expect(held).toHaveLength(2)
})

test('an exact phrase answered by words alone does not report a disabled installation setting', async ({
  page,
}) => {
  const d = page.getByRole('dialog', { name: 'Search' })
  await page.route('**/v1/search?*', (route) => route.fulfill({ json: { items: [], next: null } }))
  await d.getByLabel('Search for').fill('"customer retention"')
  await d.getByLabel('Search for').press('Enter')
  await expect(d.getByText(/Nothing found for/)).toBeVisible()
  await expect(d.getByText(/Meaning search is off/)).toHaveCount(0)
})

test('reopening after cancelling new words clears the unfinished search and its older results', async ({
  page,
}) => {
  const d = page.getByRole('dialog', { name: 'Search' })
  const field = d.getByLabel('Search for')
  const results = d.getByRole('list', { name: 'Results' })
  await field.fill('retention')
  await field.press('Enter')
  await expect(results).toBeVisible()
  await field.press('Escape')
  await page.keyboard.press('Control+k')
  await expect(field).toHaveValue('retention')
  await expect(results).toBeVisible()
  await field.fill('new words')
  await field.press('Escape')
  await expect(d).toBeHidden()
  await page.keyboard.press('Control+k')
  await expect(field).toHaveValue('')
  await expect(results).toHaveCount(0)
})

test('reopening after cancelling an unanswered first search starts empty and rejects the old response', async ({
  page,
}) => {
  const d = page.getByRole('dialog', { name: 'Search' })
  const field = d.getByLabel('Search for')
  const held = Promise.withResolvers<Route>()
  await page.route('**/v1/search?*', (route) => held.resolve(route))
  await field.fill('retention')
  await field.press('Enter')
  const original = await held.promise
  await field.press('Escape')
  await expect(d).toBeHidden()
  await page.keyboard.press('Control+k')
  await expect(field).toHaveValue('')
  const finished = page.waitForEvent('requestfinished', (r) => r === original.request())
  await original.fulfill({ json: { items: [], next: null } })
  await finished
  await page.clock.runFor(500)
  await expect(d.getByText(/Nothing found for/)).toHaveCount(0)
})
