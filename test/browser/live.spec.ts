// What the web shows stays current without reloading (review of PR18, L1–L4, P6): a tab hidden before
// the first event still catches up when shown; a brain opened again shows what changed while away; the
// brains list is asked again every 30 seconds and when the tab comes back; and the top bar holds no
// counter that leads nowhere until the Proposals screen exists.
import type { Page } from '@playwright/test'
import { expect, scenario, test } from './fixture.ts'

// The tab hidden or shown, as the browser tells the page.
async function tab(page: Page, hidden: boolean) {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (h ? 'hidden' : 'visible'),
    })
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
}

async function newBrain(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create brain' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Create a brain' })
  await dialog.getByLabel('Name').fill('Onboarding')
  await dialog.getByRole('button', { name: 'Create brain' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Onboarding' })).toBeVisible()
  const items = page.getByRole('region', { name: 'First steps' }).getByRole('listitem')
  await expect(items.nth(0)).toContainText('To do')
  return items
}

test('L1: a tab hidden before the first event catches up when shown again', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await scenario(context, baseURL as string, 'alone')
  const items = await newBrain(page)
  await tab(page, true)
  // The agent writes while nobody looks.
  await s.emit('onboarding')
  await page.waitForTimeout(300)
  await tab(page, false)
  await expect(items.nth(0)).toContainText('Done', { timeout: 3_000 })
  await expect(items.nth(1)).toContainText('Done')
})

test('L2: a brain opened again shows what happened while away', async ({ page, context, baseURL }) => {
  const s = await scenario(context, baseURL as string, 'alone')
  await newBrain(page)
  await page.getByRole('link', { name: '← All brains' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Your brains' })).toBeVisible()
  await s.emit('onboarding')
  await page.getByRole('link', { name: 'Onboarding' }).click()
  const items = page.getByRole('region', { name: 'First steps' }).getByRole('listitem')
  await expect(items.nth(0)).toContainText('Done', { timeout: 3_000 })
  await expect(page.getByRole('region', { name: 'In numbers' })).toContainText('1 entry')
})

test('L4: home asks for the brains again every 30 seconds and when the tab comes back', async ({
  page,
  context,
  baseURL,
}) => {
  await page.clock.install()
  const s = await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/')
  const card = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Legal archive' }) })
  await expect(card).toContainText('Nothing to review')
  await s.emit('legal-archive', 'proposal.submitted')
  await page.waitForTimeout(200)
  await expect(card).toContainText('Nothing to review')
  await page.clock.fastForward(30_000)
  await expect(card).toContainText('1 proposal', { timeout: 3_000 })
  await s.emit('legal-archive', 'proposal.submitted')
  await tab(page, true)
  await tab(page, false)
  await expect(card).toContainText('2 proposals', { timeout: 3_000 })
})

test('P6: no counter in the top bar while the Proposals screen does not exist', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/')
  // Proposals do wait (the cards say so), but the top bar offers no link that leads nowhere.
  await expect(page.getByText(/proposals? to review/).first()).toBeVisible()
  await expect(page.getByRole('banner').getByRole('link', { name: /to review/ })).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('banner').locator('.to-review')).toHaveCount(0)
})
