// Spec B6 «Home: mis cerebros» (T014, PR18): a card per brain with its purpose, my role, its pages and
// entries, what waits for review and the last activity; the count of proposals waiting for me in the
// top bar; «Create brain» for whoever may; «Connect your agent» always; and, for an administrator still
// alone in the installation, the way to invite people.
import { expect, noSideScroll, scenario, test } from './fixture.ts'

test.describe('the cards', () => {
  test('each brain says what it is for, my role, its size, what waits and when it last moved', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/')
    const growth = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Growth' }) })
    await expect(growth).toContainText('What we learn about audience, retention and intros.')
    await expect(growth).toContainText('curator')
    await expect(growth).toContainText('300 pages')
    await expect(growth).toContainText('1,284 entries')
    await expect(growth).toContainText('3 proposals to review')
    await expect(growth).toContainText(/Last activity/)
    const archive = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('link', { name: 'Legal archive' }) })
    await expect(archive).toContainText('archived')
    await expect(archive).toContainText('Nothing to review')
    // The whole card opens the brain.
    await growth.getByRole('link', { name: 'Growth' }).click()
    await expect(page).toHaveURL(/\/b\/growth$/)
  })

  test('the top bar counts the proposals of the brains I curate, and leads to them', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/')
    // Growth (curator) has 3; Support (contributor) has 1 that is not mine to decide.
    const counter = page.getByRole('banner').getByRole('link', { name: '3 proposals to review' })
    await expect(counter).toBeVisible()
    await counter.click()
    await expect(page).toHaveURL(/\/b\/growth$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Growth' })).toBeVisible()
  })

  test('nothing waiting: no counter in the top bar', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'member')
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'Growth' })).toBeVisible()
    await expect(page.getByRole('banner').getByRole('link', { name: /to review/ })).toHaveCount(0)
  })

  test('at 320 px the cards fit, nothing scrolls sideways', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in', { home: 'much-data' })
    await page.setViewportSize({ width: 320, height: 640 })
    await page.goto('/')
    await expect(page.getByText('63 brains')).toBeVisible()
    await noSideScroll(page)
  })
})

test.describe('create a brain', () => {
  test('an administrator alone creates the first brain and lands on its overview', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'alone')
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible()
    await page.getByRole('button', { name: 'Create brain' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Create a brain' })
    await dialog.getByLabel('Name').fill('Onboarding emails')
    // The address follows the name until the person edits it.
    await expect(dialog.getByLabel('Address')).toHaveValue('onboarding-emails')
    await dialog.getByLabel('What it is for').fill('What we learn about the first week.')
    await dialog.getByRole('button', { name: 'Create brain' }).click()
    await expect(page).toHaveURL(/\/b\/onboarding-emails$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Onboarding emails' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'First steps' })).toBeVisible()
  })

  test('a name already taken is said next to the address, and what was typed stays', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/')
    await page.getByRole('button', { name: 'Create brain' }).click()
    const dialog = page.getByRole('dialog', { name: 'Create a brain' })
    await dialog.getByLabel('Name').fill('Growth')
    await dialog.getByLabel('What it is for').fill('Kept.')
    await dialog.getByRole('button', { name: 'Create brain' }).click()
    await expect(dialog.getByText('A brain named "growth" already exists.')).toBeVisible()
    await expect(dialog.getByLabel('Address')).toBeFocused()
    await expect(dialog.getByLabel('What it is for')).toHaveValue('Kept.')
  })

  // Walked by keyboard (PR18): Enter in the last field creates the brain, as in the others.
  test('Enter in "What it is for" creates the brain', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'alone')
    await page.goto('/')
    await page.getByRole('button', { name: 'Create brain' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Create a brain' })
    await dialog.getByLabel('Name').fill('Support desk')
    await dialog.getByLabel('What it is for').fill('How customers get unstuck.')
    await dialog.getByLabel('What it is for').press('Enter')
    await expect(page).toHaveURL(/\/b\/support-desk$/)
  })

  test('a person who may not create brains is not offered to', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'member')
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'Growth' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Create brain' })).toHaveCount(0)
  })
})

test.describe('connect your agent', () => {
  test('always there; gives the command of each agent for this installation', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'member')
    await page.goto('/')
    await page.getByRole('button', { name: 'Connect your agent' }).click()
    const dialog = page.getByRole('dialog', { name: 'Connect your agent' })
    await expect(dialog.locator('pre.command').first()).toContainText(
      'claude mcp add --transport http rsc-brain https://brain.example.test/mcp',
    )
    await dialog.getByLabel('Your agent').selectOption({ label: 'Codex' })
    await expect(dialog.locator('pre.command').first()).toContainText('codex mcp add rsc-brain')
    await expect(dialog.getByText(/How to check/)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })
})

test.describe('invite people from home', () => {
  test('an administrator alone in the installation is offered to invite people', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'alone')
    await page.goto('/')
    // The setup made only them.
    await page.getByRole('link', { name: 'Invite people' }).first().click()
    await expect(page).toHaveURL(/\/people$/)
    await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible()
  })

  test('once someone else has joined, home no longer asks', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'Growth' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Invite people' })).toHaveCount(0)
  })
})
