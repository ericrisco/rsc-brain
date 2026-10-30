// Spec B6 «Estados en todas las pantallas» (CA14 for the screens of PR17): loading, empty, error with
// "try again", no access with who to ask, a lot of data, offline, and a session that ended.
import { expect, noSideScroll, PASSWORD, scenario, test } from './fixture.ts'

test.describe('home', () => {
  test('loading shows the shape of the list, then the brains', async ({ page, context, baseURL }) => {
    const s = await scenario(context, baseURL as string, 'signed-in', { home: 'loading' })
    await page.goto('/')
    await expect(page.locator('[data-state="loading"]')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Growth' })).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-state="loading"]')).toHaveCount(0)
    await s.state('home', 'normal')
  })

  test('empty says who can give access', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'member', { home: 'empty' })
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'You are not in any brain yet' })).toBeVisible()
    await expect(
      page.getByText('A curator of a brain, or an administrator, can add you to one.'),
    ).toBeVisible()
  })

  test('an error says what happened, and "try again" recovers', async ({ page, context, baseURL }) => {
    const s = await scenario(context, baseURL as string, 'signed-in', { home: 'error' })
    await page.goto('/')
    const alert = page.getByRole('alert')
    await expect(alert).toContainText('Something went wrong on the server (reference fx000001).')
    await expect(alert).toContainText('give the reference to an administrator')
    await s.state('home', 'normal')
    await alert.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByRole('link', { name: 'Growth' })).toBeVisible()
  })

  test('a lot of brains: all listed, nothing scrolls sideways', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in', { home: 'much-data' })
    await page.goto('/')
    await expect(page.getByText('63 brains')).toBeVisible()
    await expect(page.locator('.rows li')).toHaveCount(63)
    await noSideScroll(page)
  })

  test('offline after loading keeps what is on screen and says so', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'Growth' })).toBeVisible()
    await context.setOffline(true)
    await expect(page.getByText('You are offline. What you see may be out of date')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Growth' })).toBeVisible()
    await context.setOffline(false)
  })
})

test.describe('a brain', () => {
  test('one the person cannot read says so and who to ask, never a blank page', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', { brain: 'forbidden' })
    await page.goto('/b/growth')
    const alert = page.getByRole('alert')
    await expect(alert).toContainText('You cannot open this')
    await expect(alert).toContainText('ask a curator of that brain to add you')
    await expect(alert.getByRole('button', { name: 'Try again' })).toHaveCount(0)
  })

  test('one that does not exist reads the same', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/nowhere')
    await expect(page.getByRole('alert')).toContainText('No brain with that name is available to you.')
  })
})

test.describe('the session', () => {
  test('without one, a private address leads to sign-in and back', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-out')
    await page.goto('/b/support?x=1')
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fb%2Fsupport%3Fx%3D1$/)
  })

  // C1: a session that ends while the web is open leads to the sign-in form, not to a loop between the
  // sign-in page and the page (the cached "who am I" must not send the person straight back).
  test('ending mid-use, a click leads to the sign-in form and, signed in again, to that page', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'Growth' })).toBeVisible()
    await context.clearCookies()
    await page.getByRole('link', { name: 'Growth' }).click()
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fb%2Fgrowth$/)
    await expect(page.getByLabel('Email')).toBeVisible()
    // Still there a moment later: no bounce back to the brain.
    await page.waitForTimeout(500)
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fb%2Fgrowth$/)
    await page.getByLabel('Email').fill('eric@example.test')
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page).toHaveURL(/\/b\/growth$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Growth' })).toBeVisible()
  })

  // C5: a broken escape in an address is a page that does not exist, never a blank page.
  test('a malformed escape in a deep link says the page does not exist', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/%E0%A4%A')
    await expect(page.getByRole('heading', { name: 'Nothing here' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Go home' })).toBeVisible()
  })

  test('an address that is not a page of the web says so and leads home', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/nothing/here')
    await expect(page.getByRole('heading', { name: 'Nothing here' })).toBeVisible()
    await page.getByRole('link', { name: 'Go home' }).click()
    await expect(page.getByRole('heading', { name: 'Your brains' })).toBeVisible()
  })
})
