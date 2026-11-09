// What the web shows stays current without reloading (review of PR18, L1–L4, P6): a tab hidden before
// the first event still catches up when shown; a brain opened again shows what changed while away; the
// brains list is asked again every 30 seconds and when the tab comes back; and the top bar's counter of
// proposals to review leads to the inbox (it came back with the Proposals screen, PR21).
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
  await page.getByRole('link', { name: 'All brains', exact: true }).click()
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

test('P6: the counter of the top bar leads to the inbox, also on a phone', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const counter = page.getByRole('banner').getByRole('link', { name: /3 proposals to review/ })
  await expect(counter).toBeVisible()
  await expect(counter).toHaveAttribute('href', '/b/growth/proposals')
})

test('L5: step 1 marks itself after an agent only asked for context, which sends no event', async ({
  page,
  context,
  baseURL,
}) => {
  await page.clock.install()
  const s = await scenario(context, baseURL as string, 'alone')
  const items = await newBrain(page)
  // The agent's first call is for context: no event reaches the open overview.
  await s.emit('onboarding', 'context')
  await page.waitForTimeout(200)
  await expect(items.nth(0)).toContainText('To do')
  // While step 1 waits, the overview is asked again every 5 seconds.
  await page.clock.fastForward(5_000)
  await expect(items.nth(0)).toContainText('Done', { timeout: 3_000 })
  // Once done, it is not asked again. A request already on its way when the step turned may still land:
  // let it, then count.
  await page.waitForTimeout(500)
  let asked = 0
  page.on('request', (r) => {
    if (r.url().endsWith('/overview')) asked += 1
  })
  await page.clock.fastForward(15_000)
  await page.waitForTimeout(200)
  expect(asked).toBe(0)
})

test('L6: a hidden tab does not ask for the overview while step 1 waits', async ({
  page,
  context,
  baseURL,
}) => {
  await page.clock.install()
  const s = await scenario(context, baseURL as string, 'alone')
  const items = await newBrain(page)
  await tab(page, true)
  await s.emit('onboarding', 'context')
  await page.clock.fastForward(15_000)
  await page.waitForTimeout(200)
  await expect(items.nth(0)).toContainText('To do')
})
