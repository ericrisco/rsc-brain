// Spec B6 «Health» (PR23, T038): the sections of B2, each item opening where it is fixed; «ask an agent to fix
// this» copies an instruction that names the tool and the brain; empty says «Nothing to fix»; every state.
import { expect, noSideScroll, scenario, test } from './fixture.ts'

const H = '/b/growth/health'

test('the sections of B2, each item opening its page', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto(H)
  await expect(page.getByRole('heading', { level: 1, name: 'Health' })).toBeVisible()
  await expect(page.getByText('11 things to fix')).toBeVisible()
  const broken = page.getByRole('region', { name: 'Broken links' })
  await expect(broken.getByRole('listitem')).toHaveCount(3)
  await expect(broken.getByRole('listitem').first()).toContainText('links to drafts/hooks-that-work')
  const conflicts = page.getByRole('region', { name: 'Conflicts' })
  await expect(conflicts.getByRole('listitem').first().getByRole('link')).toHaveCount(2)
  await broken.getByRole('link', { name: 'audience/retention' }).click()
  await expect(page).toHaveURL(/\/b\/growth\/pages\/audience\/retention$/)
})

test('«ask an agent to fix this» copies an instruction with the tool and the brain', async ({
  page,
  context,
  baseURL,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto(H)
  const broken = page.getByRole('region', { name: 'Broken links' })
  await broken.getByRole('button', { name: 'Ask an agent to fix this' }).click()
  await expect(broken.getByText('Copied.')).toBeVisible()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied).toContain('brain_health')
  expect(copied).toContain('brain_propose')
  expect(copied).toContain('the 3 broken links')
  expect(copied).toContain('"growth"')
  await page.getByRole('button', { name: 'Ask an agent to fix all of this' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('all 11 problems')
})

test('a maintenance proposal due is said, with its instruction', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto(H)
  await expect(page.getByText('21 proposals were approved since the last maintenance.')).toBeVisible()
})

test('empty says «Nothing to fix»', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in', { health: 'empty' })
  await page.goto(H)
  await expect(page.getByRole('heading', { name: 'Nothing to fix' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Ask an agent/ })).toHaveCount(0)
})

test('much data: a long section shows ten, then all', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in', { health: 'much-data' })
  await page.goto(H)
  const orphans = page.getByRole('region', { name: 'Orphan pages' })
  await expect(orphans.getByRole('listitem')).toHaveCount(10)
  await orphans.getByRole('button', { name: 'Show all 60' }).click()
  await expect(orphans.getByRole('listitem')).toHaveCount(60)
  await expect(orphans.getByRole('listitem').nth(10).getByRole('link')).toBeFocused()
})

test('loading, error with try again, no access', async ({ page, context, baseURL }) => {
  const s = await scenario(context, baseURL as string, 'signed-in', { health: 'error' })
  await page.goto(H)
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('Something went wrong on the server')
  await s.state('health', 'normal')
  await alert.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('region', { name: 'Broken links' })).toBeVisible()
  await s.state('health', 'loading')
  await page.reload()
  await expect(page.locator('[data-state="loading"]')).toBeVisible()
  await s.state('health', 'normal')
  await s.state('brain', 'forbidden')
  await page.goto(H)
  await expect(page.getByRole('alert')).toContainText('ask a curator of that brain to add you')
})

test('320 px, dark: nothing scrolls sideways', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto(H)
  await expect(page.getByRole('region', { name: 'Broken links' })).toBeVisible()
  await noSideScroll(page)
})
