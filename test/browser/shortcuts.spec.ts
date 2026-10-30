// Spec B6 CA20: on any screen "?" shows the shortcuts, and every shortcut has a visible control that does
// the same. Each shortcut is pressed, then its visible control is used, and both must lead to the same.
import { expect, scenario, test } from './fixture.ts'

test('"?" opens the list on every screen, signed in or not', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  for (const path of ['/', '/b/growth']) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await page.keyboard.press('?')
    const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
    await expect(help).toBeVisible()
    await expect(help.locator('[data-shortcut]')).toHaveCount(path === '/' ? 3 : 4)
    await page.keyboard.press('Escape')
    await expect(help).toBeHidden()
  }
  await context.clearCookies()
  await page.goto('/sign-in')
  // The email field takes the focus on arrival, and there "?" is text; outside a field it is the list.
  await expect(page.getByLabel('Email')).toBeFocused()
  await page.getByRole('heading', { name: 'Sign in' }).click()
  await page.keyboard.press('?')
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(help.locator('[data-shortcut]')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await page.getByRole('contentinfo').getByRole('button', { name: 'Keyboard shortcuts' }).click()
  await expect(help).toBeVisible()
})

test('each shortcut and its visible control do the same', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth')
  await expect(page.getByRole('heading', { name: 'Growth' })).toBeVisible()

  // help: "?" and "Keyboard shortcuts" in the account menu.
  await page.keyboard.press('?')
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /Account/ }).click()
  await page.getByRole('button', { name: /Keyboard shortcuts/ }).click()
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
  await page.keyboard.press('Escape')

  // search: ⌘K / Ctrl K and the Search button in the header.
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog', { name: 'Search' })).toBeVisible()
  await expect(page.getByLabel('Search all your brains')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Search' })).toBeHidden()
  // ⌘K: Playwright's Chromium on macOS keeps the real key press for the browser, so there the page gets
  // the event a browser sends it; elsewhere (CI) the key is pressed.
  if (process.platform === 'darwin') {
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true })))
  } else {
    await page.keyboard.press('Meta+k')
  }
  await expect(page.getByRole('dialog', { name: 'Search' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Search' })).toBeHidden()
  await page
    .locator('header')
    .getByRole('button', { name: /Search/ })
    .click()
  await expect(page.getByRole('dialog', { name: 'Search' })).toBeVisible()
  await page.getByLabel('Search all your brains').fill('retention')
  await page.keyboard.press('Enter')
  await expect(page.getByText(/\d+ results/)).toBeVisible()
  // Esc goes back even with text in the field.
  await page.getByLabel('Search all your brains').press('Escape')
  await expect(page.getByRole('dialog', { name: 'Search' })).toBeHidden()

  // go-home: "g h" and the brand at the top left.
  await page.keyboard.press('g')
  await page.keyboard.press('h')
  await expect(page).toHaveURL(/\/$/)
  await page.goto('/b/growth')
  await expect(page.getByRole('heading', { name: 'Growth' })).toBeVisible()
  await page.locator('header').getByRole('link', { name: /home/ }).click()
  await expect(page).toHaveURL(/\/$/)

  // go-overview: "g o" and "Overview" in the side bar.
  await page.goto('/b/growth')
  await page.locator('aside').getByRole('link', { name: '← All brains' }).click()
  await page.goto('/b/growth')
  await page.keyboard.press('g')
  await page.keyboard.press('o')
  await expect(page).toHaveURL(/\/b\/growth$/)
  await page.locator('aside').getByRole('link', { name: 'Overview' }).click()
  await expect(page).toHaveURL(/\/b\/growth$/)
})

test('a letter typed in a field is text, not a shortcut', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Growth' })).toBeVisible()
  await page.keyboard.press('Control+k')
  await expect(page.getByLabel('Search all your brains')).toBeFocused()
  await page.keyboard.type('g h ?')
  await expect(page.getByLabel('Search all your brains')).toHaveValue('g h ?')
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0)
})
