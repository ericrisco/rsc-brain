// Profile (spec B6 «Profile», CA13, plan T042) against the fixture API: tokens made with a name, brains,
// permission and expiry, shown once and never again; the list with the last 4 characters, last use,
// client and expiry; revoking; connected apps; email notices by brain; a new password; the second
// factor; signing out everywhere. Each state of the screen is designed: loading, empty, error, offline,
// much data; and nothing scrolls sideways at 320 px.
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { CODE, expect, noSideScroll, PASSWORD, scenario, test } from './fixture.ts'

// CA13: the secret is nowhere the page keeps or shows: not in the DOM (text or the value of a field),
// not in storage, not in the address, not in the history entry.
async function secretGone(page: Page, secret: string) {
  const kept = await page.evaluate(() => {
    const values = [
      ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'),
    ].map((x) => x.value)
    return [
      document.documentElement.outerHTML,
      values.join('\n'),
      JSON.stringify({ ...sessionStorage }),
      JSON.stringify({ ...localStorage }),
      location.href,
      JSON.stringify(history.state),
    ].join('\n')
  })
  expect(kept.includes(secret), 'the token is nowhere on the page or in what it keeps').toBe(false)
}

test('CA13: a token is made with a name, brains, permission and expiry; shown once; then never again', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/profile')
  await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible()
  const tokens = page.getByRole('region', { name: 'Tokens' })
  // The list: last 4 characters, last use and client, expiry; one that ends soon says so.
  const laptop = tokens.getByRole('listitem').filter({ hasText: 'Claude Code laptop' })
  await expect(laptop).toContainText('…k3Qa')
  await expect(laptop).toContainText('by Claude Code')
  await expect(laptop).toContainText('Read and write')
  await expect(laptop).toContainText('All your brains')
  const ci = tokens.getByRole('listitem').filter({ hasText: 'CI reader' })
  await expect(ci).toContainText('Never used')
  await expect(ci).toContainText('growth, support')
  await expect(ci).toContainText('Ends soon')

  await tokens.getByRole('button', { name: 'Create a token' }).click()
  const form = tokens.getByRole('form', { name: 'New token' })
  // What is wrong is said before anything is sent.
  await form.getByRole('button', { name: 'Create token' }).click()
  await expect(form.getByText('Enter a name.')).toBeVisible()
  await expect(form.getByLabel('Name')).toBeFocused()
  await form.getByLabel('Name').fill('Codex desktop')
  await form.getByLabel('Only these brains').check()
  await form.getByRole('button', { name: 'Create token' }).click()
  await expect(form.getByText('Choose at least one brain, or all of them.')).toBeVisible()
  await form.getByRole('checkbox', { name: 'Growth' }).check()
  await form.getByLabel('Read only').check()
  await form.getByLabel('Expires in').selectOption('30')
  await form.getByRole('button', { name: 'Create token' }).click()

  const once = tokens.getByRole('region', { name: 'Your new token' })
  await expect(once).toContainText('only this once')
  const copy = once.getByRole('button', { name: 'Copy the token' })
  await expect(copy).toBeFocused()
  const secret = String(await once.locator('pre code').textContent()).trim()
  expect(secret).toMatch(/^rscb_/)
  // The list already has it, by its last 4 characters only.
  const row = tokens.getByRole('listitem').filter({ hasText: 'Codex desktop' })
  await expect(row).toContainText(`…${secret.slice(-4)}`)
  await expect(row).toContainText('Read')
  await expect(row).toContainText('growth')
  await expect(row).not.toContainText(secret)

  await once.getByRole('button', { name: 'Done, hide the token' }).click()
  await expect(once).toHaveCount(0)
  await expect(tokens.getByRole('status')).toContainText('hidden')
  // The keyboard stays in the section, on what it says (never dropped to the page).
  await expect(tokens.getByRole('status')).toBeFocused()
  await secretGone(page, secret)
  // Not after coming back, nor after a reload.
  await page.goto('/')
  await page.goBack()
  await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible()
  await secretGone(page, secret)
  await page.reload()
  await expect(tokens.getByRole('listitem').filter({ hasText: 'Codex desktop' })).toBeVisible()
  await secretGone(page, secret)
})

test('a token shown once survives no copy fallback: the field to copy by hand goes with it', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  // No clipboard here (plain http on a local network): the token shows in a field to copy by hand.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
  })
  await page.goto('/profile/tokens')
  const tokens = page.getByRole('region', { name: 'Tokens' })
  await tokens.getByRole('button', { name: 'Create a token' }).click()
  await tokens.getByLabel('Name').fill('By hand')
  await tokens.getByRole('button', { name: 'Create token' }).click()
  const once = tokens.getByRole('region', { name: 'Your new token' })
  const secret = String(await once.locator('pre code').textContent()).trim()
  await once.getByRole('button', { name: 'Copy the token' }).click()
  await expect(once.getByLabel('Copy this text')).toHaveValue(secret)
  await expect(once.getByLabel('Copy this text')).toBeFocused()
  await once.getByRole('button', { name: 'Done, hide the token' }).click()
  await secretGone(page, secret)
})

test('revoking a token and a connected app asks first, then says it is done', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/profile')
  const tokens = page.getByRole('region', { name: 'Tokens' })
  const ci = tokens.getByRole('listitem').filter({ hasText: 'CI reader' })
  await ci.getByRole('button', { name: 'Revoke' }).click()
  await expect(ci).toContainText('Agents using it stop at their next request.')
  await ci.getByRole('button', { name: 'Keep it' }).click()
  await expect(ci.getByRole('button', { name: 'Revoke' })).toBeFocused()
  await ci.getByRole('button', { name: 'Revoke' }).click()
  await ci.getByRole('button', { name: 'Revoke CI reader' }).click()
  await expect(tokens.getByRole('listitem').filter({ hasText: 'CI reader' })).toHaveCount(0)
  await expect(tokens.getByRole('status')).toContainText('CI reader is revoked.')

  const apps = page.getByRole('region', { name: 'Connected apps' })
  const cursor = apps.getByRole('listitem').filter({ hasText: 'Cursor' })
  await expect(cursor).toContainText('Growth')
  await expect(cursor).toContainText('Read and write')
  await expect(cursor).toContainText(/Last used/)
  await cursor.getByRole('button', { name: 'Revoke' }).click()
  await cursor.getByRole('button', { name: 'Revoke Cursor' }).click()
  await expect(apps.getByRole('status')).toContainText('Cursor is revoked.')
  await expect(apps).toContainText('No connected apps')
  await expect(apps.getByRole('link', { name: 'Connect your agent' })).toBeVisible()
})

test('email notices: a curator turns them on and off by brain; others learn why they cannot', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/profile')
  const notices = page.getByRole('region', { name: 'Email notices' })
  const growth = notices.getByRole('checkbox', { name: /Growth/ })
  await expect(growth).not.toBeChecked()
  await growth.check()
  await expect(notices.getByRole('status')).toContainText('Growth: on')
  await page.reload()
  await expect(notices.getByRole('checkbox', { name: /Growth/ })).toBeChecked()
  await expect(notices.getByRole('listitem').filter({ hasText: 'Support' })).toContainText(
    'Only curators get these',
  )
  await expect(notices.getByRole('checkbox', { name: /Support/ })).toHaveCount(0)
})

test('a new password: the wrong current one is said and kept; the right one changes it', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/profile')
  const pw = page.getByRole('form', { name: 'Change your password' })
  await pw.getByLabel('Current password').fill('not my password at all')
  await pw.getByLabel('New password').fill('a much longer passphrase')
  await pw.getByRole('button', { name: 'Change password' }).click()
  await expect(pw.getByRole('alert')).toContainText('The current password is not right.')
  await expect(pw.getByLabel('New password')).toHaveValue('a much longer passphrase')
  await pw.getByLabel('Current password').fill(PASSWORD)
  await pw.getByRole('button', { name: 'Change password' }).click()
  await expect(pw.getByRole('status')).toContainText('Password changed. Your other sessions are signed out.')
  await expect(pw.getByLabel('Current password')).toHaveValue('')
  await expect(pw.getByLabel('New password')).toHaveValue('')
})

test('a wrong current password marks its field; the right one says what still works', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/profile')
  const pw = page.getByRole('form', { name: 'Change your password' })
  await pw.getByLabel('Current password').fill('not my password at all')
  await pw.getByLabel('New password').fill('a much longer passphrase')
  await pw.getByRole('button', { name: 'Change password' }).click()
  await expect(pw.getByLabel('Current password')).toHaveAttribute('aria-invalid', 'true')
  await expect(pw.getByLabel('Current password')).toBeFocused()
  await expect(pw.getByLabel('New password')).not.toHaveAttribute('aria-invalid', 'true')
  await pw.getByLabel('Current password').fill(PASSWORD)
  await pw.getByRole('button', { name: 'Change password' }).click()
  // Two working tokens (the expired one does not count) and one app.
  await expect(pw.getByRole('status')).toContainText(
    'Your other sessions are signed out. Your 2 tokens and 1 connected app still work.',
  )
  await expect(pw.getByLabel('Current password')).not.toHaveAttribute('aria-invalid', 'true')
})

test('with a second factor on, a new password asks for the code too', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'member')
  await page.goto('/profile')
  const pw = page.getByRole('form', { name: 'Change your password' })
  await pw.getByLabel('Current password').fill(PASSWORD)
  await pw.getByLabel('New password').fill('a much longer passphrase')
  await pw.getByLabel('Code from your authenticator app').fill('000000')
  await pw.getByRole('button', { name: 'Change password' }).click()
  await expect(pw.getByRole('alert')).toContainText('The code is not right.')
  await expect(pw.getByLabel('Code from your authenticator app')).toHaveAttribute('aria-invalid', 'true')
  await pw.getByLabel('Code from your authenticator app').fill(CODE)
  await pw.getByRole('button', { name: 'Change password' }).click()
  await expect(pw.getByRole('status')).toContainText('Password changed.')
})

test('«Revoke all tokens and apps» asks first, then says how many', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/profile')
  const all = page.getByRole('region', { name: 'Revoke everything' })
  await all.getByRole('button', { name: 'Revoke all tokens and apps' }).click()
  await expect(all).toContainText('Every agent and program using them stops at its next request.')
  await all.getByRole('button', { name: 'Yes, revoke them all' }).click()
  await expect(all.getByRole('status')).toContainText('3 tokens and 1 connected app are revoked.')
  await expect(page.getByRole('region', { name: 'Tokens' })).toContainText('No tokens yet')
  await expect(page.getByRole('region', { name: 'Connected apps' })).toContainText('No connected apps')
})

test('expired tokens are in a group of their own; connected apps name their brains', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/profile')
  const tokens = page.getByRole('region', { name: 'Tokens' })
  const expired = tokens.getByRole('list', { name: 'Expired' })
  await expect(expired.getByRole('listitem')).toHaveCount(1)
  await expect(expired).toContainText('Old laptop')
  await expect(expired).toContainText('Ended 30 Aug 2026')
  await expect(tokens.getByRole('list', { name: 'Your tokens' })).not.toContainText('Old laptop')
  const cursor = page
    .getByRole('region', { name: 'Connected apps' })
    .getByRole('listitem')
    .filter({ hasText: 'Cursor' })
  await expect(cursor).toContainText('Growth')
  await expect(cursor).not.toContainText('growth')
})

test('email notices: a refusal puts the box back and says why', async ({ page, context, baseURL }) => {
  const s = await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/profile')
  const notices = page.getByRole('region', { name: 'Email notices' })
  const growth = notices.getByRole('checkbox', { name: /Growth/ })
  await expect(growth).not.toBeChecked()
  await s.state('notify', 'error')
  await growth.click()
  await expect(notices.getByRole('alert')).toContainText('Something went wrong on the server')
  await expect(growth).not.toBeChecked()
})

test('the second factor: a code that is not 6 digits is said at once, without asking the server', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/profile')
  const tf = page.getByRole('region', { name: 'Second factor' })
  await tf.getByRole('button', { name: 'Turn on' }).click()
  await expect(tf.getByRole('img', { name: 'QR code of the key' })).toBeVisible()
  // The keyboard is on the code, put there by the screen.
  await expect(tf.getByLabel('Code from the app')).toBeFocused()
  let asked = 0
  page.on('request', (r) => {
    if (r.url().endsWith('/v1/me/totp/confirm')) asked += 1
  })
  await tf.getByLabel('Code from the app').fill('12')
  await tf.getByRole('button', { name: 'Turn on' }).click()
  await expect(tf.getByRole('alert')).toContainText('Type the 6 digits your app shows.')
  expect(asked).toBe(0)
  // Cancel gives the keyboard back to the button that opened it.
  await tf.getByRole('button', { name: 'Cancel' }).click()
  await expect(tf.getByRole('button', { name: 'Turn on' })).toBeFocused()
  await tf.getByRole('button', { name: 'Turn on' }).click()
  await tf.getByLabel('Code from the app').fill(CODE)
  await tf.getByRole('button', { name: 'Turn on' }).click()
  await expect(tf.getByRole('status')).toContainText('The second factor is on.')
  await expect(tf.getByRole('status')).toBeFocused()
})

test('a token or a key shown is forgotten when the page goes to the back/forward cache', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/profile')
  const tokens = page.getByRole('region', { name: 'Tokens' })
  await tokens.getByRole('button', { name: 'Create a token' }).click()
  await tokens.getByLabel('Name').fill('Cached')
  await tokens.getByRole('button', { name: 'Create token' }).click()
  const secret = String(
    await tokens.getByRole('region', { name: 'Your new token' }).locator('pre code').textContent(),
  ).trim()
  await page.getByRole('region', { name: 'Second factor' }).getByRole('button', { name: 'Turn on' }).click()
  await expect(page.getByText('JBSW Y3DP')).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
  await expect(tokens.getByRole('region', { name: 'Your new token' })).toHaveCount(0)
  await expect(page.getByText('JBSW Y3DP')).toHaveCount(0)
  await secretGone(page, secret)
})

test('the second factor: turned on with a code from the app, and off again', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/profile')
  const tf = page.getByRole('region', { name: 'Second factor' })
  await expect(tf).toContainText('Off')
  await tf.getByRole('button', { name: 'Turn on' }).click()
  await expect(tf).toContainText('JBSW Y3DP EHPK 3PXP JBSW Y3DP')
  await expect(tf.getByRole('link', { name: 'Open in your authenticator app' })).toHaveAttribute(
    'href',
    /^otpauth:\/\/totp\//,
  )
  await tf.getByLabel('Code from the app').fill('000000')
  await tf.getByRole('button', { name: 'Turn on' }).click()
  await expect(tf.getByRole('alert')).toContainText('The code is not right.')
  await tf.getByLabel('Code from the app').fill(CODE)
  await tf.getByRole('button', { name: 'Turn on' }).click()
  await expect(tf.getByRole('status')).toContainText('The second factor is on.')
  await expect(tf).not.toContainText('JBSW')
  await tf.getByRole('button', { name: 'Turn off' }).click()
  await tf.getByLabel('Code from the app').fill(CODE)
  await tf.getByRole('button', { name: 'Turn off the second factor' }).click()
  await expect(tf.getByRole('status')).toContainText('The second factor is off.')
})

test('sign out everywhere asks first, then leads to sign-in', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/profile')
  const out = page.getByRole('region', { name: 'Sign out everywhere' })
  await out.getByRole('button', { name: 'Sign out everywhere' }).click()
  await expect(out).toContainText('Tokens and connected apps keep working')
  await out.getByRole('button', { name: 'Yes, sign out everywhere' }).click()
  await expect(page).toHaveURL(/\/sign-in$/)
  await expect(page.getByRole('status').filter({ hasText: 'Signed out.' })).toBeVisible()
})

test('the account menu leads to the profile and to connecting an agent', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'member')
  await page.goto('/')
  await page.getByRole('button', { name: /Account/ }).click()
  await page.locator('#account-menu').getByRole('link', { name: 'Profile' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible()
  await page.getByRole('button', { name: /Account/ }).click()
  await page.locator('#account-menu').getByRole('link', { name: 'Connect your agent' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Connect your agent' })).toBeVisible()
})

test('states: loading has the shape, empty says what a token is, an error offers to try again', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await scenario(context, baseURL as string, 'signed-in', { tokens: 'loading', apps: 'empty' })
  await page.goto('/profile')
  const tokens = page.getByRole('region', { name: 'Tokens' })
  await expect(tokens.locator('[data-state="loading"]')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Connected apps' })).toContainText('No connected apps')
  await s.state('tokens', 'empty')
  await page.reload()
  await expect(tokens.locator('[data-state="empty"]')).toContainText('No tokens yet')
  await s.state('tokens', 'error')
  await page.reload()
  await expect(tokens.getByRole('alert')).toContainText('This did not load')
  await s.state('tokens', 'normal')
  await tokens.getByRole('button', { name: 'Try again' }).click()
  await expect(tokens.getByRole('listitem').filter({ hasText: 'CI reader' })).toBeVisible()
})

test('much data: tokens come 20 at a time', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in', { tokens: 'much-data' })
  await page.goto('/profile')
  const tokens = page.getByRole('region', { name: 'Tokens' })
  await expect(tokens.getByRole('list', { name: 'Your tokens' }).getByRole('listitem')).toHaveCount(20)
  await tokens.getByRole('button', { name: 'Show all 42' }).click()
  await expect(tokens.getByRole('list', { name: 'Your tokens' }).getByRole('listitem')).toHaveCount(42)
})

test('offline: writes are off and say why', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/profile')
  await expect(page.getByRole('region', { name: 'Tokens' }).getByRole('listitem').first()).toBeVisible()
  await context.setOffline(true)
  const tokens = page.getByRole('region', { name: 'Tokens' })
  await expect(tokens.getByRole('button', { name: 'Create a token' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await expect(
    tokens.getByText('You are offline: this cannot be sent until the connection is back.').first(),
  ).toBeVisible()
  await context.setOffline(false)
})

for (const width of [320, 375] as const) {
  test(`at ${width} px nothing scrolls sideways, with a token shown`, async ({ page, context, baseURL }) => {
    await page.setViewportSize({ width, height: 740 })
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/profile')
    const tokens = page.getByRole('region', { name: 'Tokens' })
    await tokens.getByRole('button', { name: 'Create a token' }).click()
    await tokens.getByLabel('Name').fill('Phone')
    await tokens.getByRole('button', { name: 'Create token' }).click()
    await expect(tokens.getByRole('region', { name: 'Your new token' })).toBeVisible()
    await noSideScroll(page)
    await page.getByRole('region', { name: 'Second factor' }).getByRole('button', { name: 'Turn on' }).click()
    await noSideScroll(page)
  })
}

// The two states are audited apart, each in view: with both open, the second factor's code field takes the
// focus and scrolls the token under the sticky top bar, which is a layout of the test, not of a person.
for (const theme of ['dark', 'light'] as const) {
  test(`axe: profile with a token shown, then the second factor being set up, ${theme}`, async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.addInitScript((t) => localStorage.setItem('rscb.theme', t), theme)
    await page.goto('/profile')
    const audit = async (where: string) => {
      const r = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
        .analyze()
      const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
      expect(bad.map((v) => `${where}: ${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual([])
    }
    const tokens = page.getByRole('region', { name: 'Tokens' })
    await tokens.getByRole('button', { name: 'Create a token' }).click()
    await audit('new token form')
    await tokens.getByLabel('Name').fill('Axe')
    await tokens.getByRole('button', { name: 'Create token' }).click()
    await expect(tokens.getByRole('region', { name: 'Your new token' })).toBeVisible()
    await audit('token shown')
    await tokens.getByRole('button', { name: 'Done, hide the token' }).click()
    await page.getByRole('region', { name: 'Second factor' }).getByRole('button', { name: 'Turn on' }).click()
    await expect(page.getByLabel('Code from the app')).toBeVisible()
    await audit('second factor')
  })
}
