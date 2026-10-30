// Spec B6 «Mapa de la web», «Accesibilidad» and DESIGN.md (plan T003): the frame at 1440, 768, 390 and
// 320 px without sideways scroll, the side bar that folds into a menu on a phone, the account menu with
// the light theme, signing out, and a visible focus.
import { expect, noSideScroll, scenario, test } from './fixture.ts'

const WIDTHS = [1440, 768, 390, 320]

for (const width of WIDTHS) {
  test(`at ${width}px nothing scrolls sideways on any screen of this version`, async ({
    page,
    context,
    baseURL,
  }) => {
    await page.setViewportSize({ width, height: 800 })
    await scenario(context, baseURL as string, 'signed-in')
    for (const path of ['/', '/b/growth', '/nothing']) {
      await page.goto(path)
      await expect(page.locator('main')).toBeVisible()
      await page.waitForLoadState('networkidle')
      await noSideScroll(page)
    }
    await context.clearCookies()
    for (const path of ['/sign-in', '/reset', '/invite#token=inv_fixture_good_token_0001']) {
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      await noSideScroll(page)
    }
  })
}

test('inside a brain, the side bar holds its sections on a wide screen', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth')
  const side = page.locator('aside.sidebar')
  await expect(side).toBeVisible()
  await expect(side.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
  await side.getByRole('link', { name: '← All brains' }).click()
  await expect(page.getByRole('heading', { name: 'Your brains' })).toBeVisible()
})

test('on a phone, the side bar folds into a menu that Esc closes, giving the focus back', async ({
  page,
  context,
  baseURL,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth')
  await expect(page.locator('aside.sidebar')).toBeHidden()
  const menu = page.getByRole('button', { name: 'Menu' })
  await menu.click()
  const sheet = page.getByRole('dialog', { name: 'Growth' })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('link', { name: 'Overview' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await expect(menu).toBeFocused()
  await menu.click()
  await page.getByRole('dialog', { name: 'Growth' }).getByRole('link', { name: '← All brains' }).click()
  await expect(page.getByRole('heading', { name: 'Your brains' })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('the light theme is a choice that stays; dark is the default', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('button', { name: /Account/ }).click()
  await page.getByRole('button', { name: /Light theme/ }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  const ground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(ground)
})

test('the account menu signs out, and the web forgets the person', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/')
  await page.getByRole('button', { name: /Account/ }).click()
  await expect(page.getByText('eric@example.test')).toBeVisible()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/sign-in$/)
  await page.goto('/')
  await expect(page).toHaveURL(/\/sign-in/)
})

// C2: a sign-out that did not happen is never shown as done: the person stays signed in and is told.
for (const how of ['the server fails', 'the browser is offline'] as const) {
  test(`when signing out fails (${how}), it says so and the person stays signed in`, async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(
      context,
      baseURL as string,
      'signed-in',
      how === 'the server fails' ? { 'sign-out': 'error' } : {},
    )
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'Growth' })).toBeVisible()
    await page.getByRole('button', { name: /Account/ }).click()
    if (how === 'the browser is offline') await context.setOffline(true)
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByRole('alert')).toContainText(
      "Couldn't sign out. Check your connection and try again.",
    )
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
    await context.setOffline(false)
    await page.reload()
    await expect(page.getByRole('link', { name: 'Growth' })).toBeVisible()
  })
}

test('the focus is always visible: a 2px outline in the accent', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Growth' })).toBeVisible()
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab')
    const o = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement
      const s = getComputedStyle(el)
      return { tag: el.tagName, width: Number.parseFloat(s.outlineWidth), style: s.outlineStyle }
    })
    // The skip link shows itself instead of an outline.
    if (o.tag === 'A' && i === 0) continue
    expect(o.style, `${o.tag} at Tab ${i + 1}`).not.toBe('none')
    expect(o.width).toBeGreaterThanOrEqual(2)
  }
})
