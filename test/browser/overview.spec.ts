// Spec B6 «Overview de un cerebro» and CA19 (T015, PR18): a brain at a glance — purpose, numbers,
// today's sessions with their summary, what waits for review, health — and, for a new brain, the three
// first steps, each marked by itself when it happens (an agent's first entry arrives by the live feed,
// without reloading). Importing waits for its operation (B7): the screen says so and offers what works.
import { expect, noSideScroll, scenario, test } from './fixture.ts'

test.describe('a new brain', () => {
  test("CA19: two first steps and a tip; the agent's first entry marks both without reloading", async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'alone')
    await page.goto('/')
    await page.getByRole('button', { name: 'Create brain' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Create a brain' })
    await dialog.getByLabel('Name').fill('Onboarding')
    await dialog.getByRole('button', { name: 'Create brain' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Onboarding' })).toBeVisible()
    const steps = page.getByRole('region', { name: 'First steps' })
    const items = steps.getByRole('listitem')
    // Two steps that work today; importing a folder is a tip under them, not a step that cannot be done.
    await expect(items).toHaveCount(2)
    await expect(items.nth(0)).toContainText('Connect your agent')
    // A screen reader hears each step with its number.
    await expect(steps.getByRole('heading', { level: 3, name: '1. Connect your agent' })).toBeVisible()
    await expect(items.nth(0)).toContainText('To do')
    // Step 1 says what marks it.
    await expect(items.nth(0)).toContainText('when your agent opens a session, searches, reads or saves')
    await expect(items.nth(1)).toContainText('first entry')
    await expect(items.nth(1)).toContainText('To do')
    const tip = steps.getByRole('note')
    await expect(tip).toContainText('Import')
    await expect(tip).toContainText('not in this version yet')
    await expect(tip.getByRole('button', { name: /Copy/ })).toBeVisible()
    await expect(steps).not.toContainText('Not available yet')
    // The first step opens the connection kit, naming this brain.
    await items.nth(0).getByRole('button', { name: 'Connect your agent' }).click()
    await expect(page.getByRole('dialog', { name: 'Connect your agent' })).toContainText('onboarding')
    await page.keyboard.press('Escape')
    // The agent writes; the page hears it.
    const url = page.url()
    await s.emit('onboarding')
    await expect(items.nth(0)).toContainText('Done', { timeout: 5_000 })
    await expect(items.nth(1)).toContainText('Done')
    expect(page.url()).toBe(url)
    await expect(page.getByText('1 entry', { exact: false }).first()).toBeVisible()
  })
})

test.describe('a brain at work', () => {
  test("numbers, today's sessions with their summary, what waits and its health", async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth')
    await expect(page.getByRole('heading', { level: 1, name: 'Growth' })).toBeVisible()
    await expect(page.getByText('What we learn about audience, retention and intros.')).toBeVisible()
    const numbers = page.getByRole('region', { name: 'In numbers' })
    await expect(numbers).toContainText('300')
    await expect(numbers).toContainText('1,284')
    await expect(numbers).toContainText('37')
    // No first steps once the brain works.
    await expect(page.getByRole('region', { name: 'First steps' })).toHaveCount(0)
    const today = page.getByRole('region', { name: "Today's sessions" })
    await expect(today.getByRole('listitem')).toHaveCount(3)
    await expect(today).toContainText('Review the intros of October')
    await expect(today).toContainText('Claude Code')
    await expect(today).toContainText('Short intros keep viewers past 30 seconds')
    await expect(today).toContainText('open')
    // A program without a purpose: said in words, never a raw user agent.
    const third = today.getByRole('listitem').nth(2)
    await expect(third).toContainText('No purpose given')
    await expect(third).toContainText('an API client')
    await expect(today).not.toContainText('curl/')
    await expect(today).not.toContainText('Session without a purpose')
    const waiting = page.getByRole('region', { name: 'Waiting for review' })
    await expect(waiting.getByRole('listitem')).toHaveCount(3)
    await expect(waiting).toContainText('Intros: keep them under 10 seconds')
    await expect(waiting).toContainText('old')
    const health = page.getByRole('region', { name: 'Health' })
    await expect(health).toContainText('3 broken links')
    await expect(health).toContainText('4 orphan pages')
  })

  test('a quiet day and a healthy wiki say so', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/legal-archive')
    await expect(page.getByRole('heading', { level: 1, name: 'Legal archive' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Health' })).toContainText('Nothing to fix')
    await expect(page.getByRole('region', { name: 'Waiting for review' })).toContainText(
      'Nothing waits for review',
    )
  })

  test('at 320 px nothing scrolls sideways', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in', { overview: 'much-data' })
    await page.setViewportSize({ width: 320, height: 640 })
    await page.goto('/b/growth')
    await expect(page.getByRole('region', { name: "Today's sessions" }).getByRole('listitem')).toHaveCount(20)
    await noSideScroll(page)
  })
})

test.describe('states', () => {
  test('loading keeps the shape, then the overview', async ({ page, context, baseURL }) => {
    const s = await scenario(context, baseURL as string, 'signed-in', { overview: 'loading' })
    await page.goto('/b/growth')
    await expect(page.locator('[data-state="loading"]').first()).toBeVisible()
    await expect(page.getByRole('region', { name: 'In numbers' })).toBeVisible({ timeout: 10_000 })
    await s.state('overview', 'normal')
  })

  test('an error says what happened, and "try again" recovers', async ({ page, context, baseURL }) => {
    const s = await scenario(context, baseURL as string, 'signed-in', { overview: 'error' })
    await page.goto('/b/growth')
    const alert = page.getByRole('alert')
    await expect(alert).toContainText('Something went wrong on the server')
    await s.state('overview', 'normal')
    await alert.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByRole('region', { name: 'In numbers' })).toBeVisible()
  })

  test('offline keeps what is on screen', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth')
    await expect(page.getByRole('region', { name: 'In numbers' })).toBeVisible()
    await context.setOffline(true)
    await expect(page.getByText('You are offline.')).toBeVisible()
    await expect(page.getByRole('region', { name: 'In numbers' })).toBeVisible()
    await context.setOffline(false)
  })
})
