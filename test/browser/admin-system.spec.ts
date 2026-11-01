// The rest of the administration (spec B6 «Admin»: Email, Meaning search, Limits, Audit, Backups & system,
// Branding; plan T047, PR25b), against the fixture API: secrets that never come back (only "set" and the last
// 4), a test mail and the failures, meaning search that stays off until the warning is accepted and shows its
// progress, a limit within bounds, the audit filtered with a download of the same rows, the health of the
// service with B7 said honestly, and the logo and name in the header. Saves are explicit, field by field on
// what was read; unsaved edits survive a tab switch; risky actions ask first; the keyboard never falls to the
// page. Only the administration reaches it.
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, noSideScroll, scenario, test } from './fixture.ts'

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze()
  const bad = r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${where}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  expect(bad).toEqual([])
}

const notOnBody = async (page: Page) =>
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY')

const status = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text })

const TABS = [
  ['Email', '/admin/email', 'Outgoing mail'],
  ['Meaning search', '/admin/meaning', 'Meaning search'],
  ['Limits', '/admin/limits', 'Requests per key'],
  ['Audit', '/admin/audit', 'Audit'],
  ['Backups & system', '/admin/system', 'Service'],
  ['Branding', '/admin/branding', 'Name'],
] as const

test.describe('administration: the rest of it', () => {
  test('every part has its tab, its page and no serious accessibility problem; nothing scrolls sideways at 320', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/people')
    const nav = page.getByRole('navigation', { name: 'Administration' })
    for (const [label, href, heading] of TABS) {
      await nav.getByRole('link', { name: label, exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`${href}$`))
      await expect(nav.getByRole('link', { name: label, exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      )
      await expect(page.getByRole('heading', { level: 2, name: heading, exact: true })).toBeVisible()
      await audit(page, label)
    }
    await page.setViewportSize({ width: 320, height: 700 })
    for (const [, href, heading] of TABS) {
      await page.goto(href)
      await expect(page.getByRole('heading', { level: 2, name: heading, exact: true })).toBeVisible()
      await noSideScroll(page)
    }
  })

  test('only the administration: a member sees why, and whom to ask', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'member')
    await page.goto('/admin/email')
    await expect(page.getByText('Only the administration of this installation opens this.')).toBeVisible()
    await expect(page.getByLabel('Mail server')).toHaveCount(0)
  })
})

test.describe('administration: email', () => {
  test('the password is never shown: only that it is set and its last 4; it is kept unless replaced', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/email')
    const pw = page.getByRole('group', { name: 'Password' })
    await expect(pw).toContainText('Keep the current one (set)')
    await expect(pw.getByRole('radio', { name: /Keep the current one/ })).toBeChecked()
    // Typing a new password needs choosing to; the box is a password box and starts empty.
    await pw.getByRole('radio', { name: 'Use a new one' }).check()
    const fresh = page.getByLabel('New password')
    await expect(fresh).toHaveAttribute('type', 'password')
    await expect(fresh).toHaveValue('')
    await fresh.fill('another-secret-9876')
    const put = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith('/v1/admin/mail'))
    await page.getByRole('button', { name: 'Save mail settings' }).click()
    expect((await put).postDataJSON().password).toBe('another-secret-9876')
    await expect(status(page, 'Mail settings saved.')).toBeFocused()
    await expect(pw).toContainText('Keep the current one (set)')
    await expect(page.getByLabel('New password')).toHaveCount(0)
    await expect(page.locator('body')).not.toContainText('another-secret')
  })

  test('nothing changed still asks the server, and says so', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/email')
    await expect(page.getByLabel('Mail server')).toHaveValue('smtp.example.test')
    const put = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith('/v1/admin/mail'))
    await page.getByRole('button', { name: 'Save mail settings' }).click()
    expect((await put).postDataJSON().base.host).toBe('smtp.example.test')
    await expect(status(page, 'Nothing changed.')).toBeFocused()
  })

  test('saved meanwhile by another administrator: their value shows, what I typed stays, a second save goes', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/email')
    await page.getByLabel('Send as (name)').fill('Acme mail')
    await fetch(`${baseURL}/__fixture/scenarios/${s.id}/admin-edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mailHost: 'smtp.theirs.test' }),
    })
    await page.getByRole('button', { name: 'Save mail settings' }).click()
    await expect(page.getByRole('alert')).toContainText('Someone changed this while you edited it.')
    await expect(page.getByLabel('Mail server')).toHaveValue('smtp.theirs.test')
    await expect(page.getByLabel('Send as (name)')).toHaveValue('Acme mail')
    await notOnBody(page)
    await page.getByRole('button', { name: 'Save mail settings' }).click()
    await expect(status(page, 'Mail settings saved.')).toBeVisible()
  })

  test('a test email, and a failure shown among the recent send failures with its reason', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/email')
    const failures = page.getByRole('region', { name: 'Recent send failures' })
    await expect(failures).toContainText('timeout')
    await expect(page.getByLabel('Send a test email to')).toHaveValue('eric@example.test')
    await page.getByRole('button', { name: 'Send test email' }).click()
    await expect(status(page, 'Sent to eric@example.test')).toBeFocused()
    await page.getByLabel('Mail server').fill('down.example.test')
    // Another server: the password goes with it.
    await page.getByRole('radio', { name: 'Use a new one' }).check()
    await page.getByLabel('New password').fill('down-server-password')
    await page.getByRole('button', { name: 'Save mail settings' }).click()
    await expect(status(page, 'Mail settings saved.')).toBeVisible()
    await page.getByRole('button', { name: 'Send test email' }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'It did not go' })).toContainText(
      'server not found',
    )
    await expect(failures.getByRole('listitem').first()).toContainText('server not found')
  })

  test('removing the mail settings asks first, and says what stops', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/email')
    await page.getByRole('button', { name: 'Remove mail settings' }).click()
    const dialog = page.getByRole('dialog', { name: 'Remove the mail settings?' })
    await expect(dialog).toContainText('invitations and reset links')
    await dialog.getByRole('button', { name: 'Keep them' }).click()
    await expect(page.getByLabel('Mail server')).toHaveValue('smtp.example.test')
    await page.getByRole('button', { name: 'Remove mail settings' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Remove mail settings' }).click()
    await expect(status(page, 'Mail settings removed.')).toBeFocused()
    await expect(page.getByText('Mail is not set up')).toBeVisible()
    await expect(page.getByLabel('Mail server')).toHaveValue('')
  })

  test('while loading, no box to type in; then the settings', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in', { 'admin-email': 'loading' })
    await page.goto('/admin/email')
    await expect(page.getByRole('heading', { level: 2, name: 'Outgoing mail' })).toBeVisible()
    await expect(page.getByRole('textbox')).toHaveCount(0)
    await expect(page.getByLabel('Mail server')).toHaveValue('smtp.example.test', { timeout: 6000 })
  })
})

test.describe('administration: meaning search', () => {
  test('a key that is never shown; on only once the warning is accepted; progress in words; off asks first', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/meaning')
    await expect(page.getByText('Off: searches use words only.')).toBeVisible()
    const openai = page.getByRole('region', { name: 'OpenAI' })
    await expect(openai).toContainText('Key: Not set')
    const key = openai.getByLabel('OpenAI API key')
    await expect(key).toHaveAttribute('type', 'password')
    await key.fill('sk-test-0123456789abcdefghij-k9Z2')
    await openai.getByRole('button', { name: 'Save key' }).click()
    await expect(openai).toContainText('Key: Set here, ends in …k9Z2')
    await expect(key).toHaveValue('')
    await notOnBody(page)
    await expect(page.locator('body')).not.toContainText('0123456789abcdefghij')
    // Turning on: the provider, the warning, and a box to accept it.
    const on = page.getByRole('region', { name: 'Turn on meaning search' })
    await on.getByRole('radio', { name: /OpenAI/ }).check()
    await expect(on).toContainText('cannot be taken back')
    const go = on.getByRole('button', { name: 'Turn on meaning search' })
    await expect(go).toHaveAttribute('aria-disabled', 'true')
    await expect(on).toContainText('Accept the warning first.')
    await on.getByRole('checkbox', { name: /I understand/ }).check()
    await go.click()
    await expect(status(page, 'Meaning search is on with OpenAI.')).toBeFocused()
    const progress = page.getByRole('progressbar', { name: 'Processing' })
    await expect(progress).toBeVisible()
    await expect(page.getByText(/of 3,400 texts processed|All 3,400 texts processed/)).toBeVisible()
    await expect(page.getByText('All 3,400 texts processed')).toBeVisible({ timeout: 20_000 })
    // Removing the key in use: the server says why not.
    await openai.getByRole('button', { name: 'Remove the key' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Remove the key' }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'Turn meaning search off first' })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Turn off meaning search' }).click()
    const dialog = page.getByRole('dialog', { name: 'Turn off meaning search?' })
    await expect(dialog).toContainText('words only')
    await dialog.getByRole('button', { name: 'Turn off meaning search' }).click()
    await expect(status(page, 'Meaning search is off.')).toBeFocused()
  })
})

test.describe('administration: limits', () => {
  test('the limit per key stays within bounds; an edit survives a tab switch; the save is explicit', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/limits')
    const field = page.getByLabel('Requests per minute, per key')
    await expect(field).toHaveValue('600')
    await field.fill('30')
    await page.getByRole('button', { name: 'Save the limit' }).click()
    await expect(page.getByText('A whole number from 60 to 10,000.')).toBeVisible()
    await expect(field).toBeFocused()
    await field.fill('1200')
    // Away and back: what was typed is still there, not saved.
    await page
      .getByRole('navigation', { name: 'Administration' })
      .getByRole('link', { name: 'Audit' })
      .click()
    await page
      .getByRole('navigation', { name: 'Administration' })
      .getByRole('link', { name: 'Limits' })
      .click()
    await expect(page.getByLabel('Requests per minute, per key')).toHaveValue('1200')
    await page.getByRole('button', { name: 'Save the limit' }).click()
    await expect(status(page, 'Saved.')).toBeFocused()
    await page.reload()
    await expect(page.getByLabel('Requests per minute, per key')).toHaveValue('1200')
  })
})

test.describe('administration: audit', () => {
  test('filters by who, action, brain and date; more by pages; the download asks for the same rows', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/audit')
    const rows = page.getByRole('table', { name: 'Audit lines' }).getByRole('row')
    await expect(rows).toHaveCount(101)
    await page.getByRole('button', { name: /Show 100 more/ }).click()
    await expect(rows).toHaveCount(201)
    await notOnBody(page)
    const filters = page.getByRole('group', { name: 'Filter the audit' })
    await filters.getByLabel('Who').selectOption({ label: 'Ana' })
    await filters.getByLabel('Action').fill('member.')
    await filters.getByLabel('From').fill('2026-10-01')
    await filters.getByLabel('To').fill('2026-10-31')
    await page.getByRole('button', { name: 'Apply filters' }).click()
    await expect(rows.nth(1)).toContainText('member.')
    const n = await rows.count()
    const link = page.getByRole('link', { name: 'Download these lines (CSV)' })
    const href = new URL((await link.getAttribute('href')) as string, 'http://x')
    expect(href.pathname).toBe('/v1/admin/audit/export')
    expect(href.searchParams.get('actor')).toBe('acc_ana')
    expect(href.searchParams.get('action')).toBe('member.')
    expect(href.searchParams.get('to')).toBe(new Date(2026, 10, 1).toISOString())
    // The file holds exactly the lines on the screen.
    const csv = await (await page.request.get(href.pathname + href.search)).text()
    expect(csv.trim().split('\r\n').length - 1).toBe(n - 1)
    expect(csv).not.toMatch(/,=HYPERLINK/)
    // No lines: say so, and offer to clear.
    await filters.getByLabel('Action').fill('nothing.')
    await page.getByRole('button', { name: 'Apply filters' }).click()
    await expect(page.getByText('No lines for these filters.')).toBeVisible()
    await page.getByRole('button', { name: 'Clear filters' }).first().click()
    await expect(rows).toHaveCount(101)
  })
})

test.describe('administration: backups & system', () => {
  test('the version and the health of the service; backups said honestly, with no button that does nothing', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/system')
    const service = page.getByRole('region', { name: 'Service' })
    await expect(service).toContainText('0.1.0')
    await expect(service).toContainText('0020_branding_factory_keys')
    await expect(service).toContainText('2 of 200')
    const backups = page.getByRole('region', { name: 'Backups' })
    await expect(backups).toContainText('arrive with the install release')
    await expect(backups.getByRole('button')).toHaveCount(0)
  })

  test('the address of RSC Factory: checked before it is sent, saved explicitly', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/system')
    const field = page.getByLabel('Address of RSC Factory')
    await field.fill('http://factory.example.test')
    await page.getByRole('button', { name: 'Save the address' }).click()
    await expect(page.getByText(/Use an https address/)).toBeVisible()
    await expect(field).toBeFocused()
    await field.fill('https://factory.example.test')
    await page.getByRole('button', { name: 'Save the address' }).click()
    await expect(status(page, 'Saved.')).toBeFocused()
    const me = await (await page.request.get('/v1/me')).json()
    expect(me.installation.factoryUrl).toBe('https://factory.example.test')
  })
})

test.describe('administration: branding', () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC',
    'base64',
  )

  test('a logo and a name shown in the header; an SVG refused before it is sent; removing asks first', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/branding')
    await expect(
      page.getByText('No logo: the header shows the RSC mark, and emails show the name only.'),
    ).toBeVisible()
    const file = page.getByLabel('Choose a logo')
    await file.setInputFiles({ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') })
    await expect(page.getByText(/SVG is not accepted/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Upload this logo' })).toHaveCount(0)
    await file.setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG })
    await expect(page.getByRole('img', { name: 'The logo you chose' })).toBeVisible()
    await page.getByRole('button', { name: 'Upload this logo' }).click()
    await expect(status(page, /Logo uploaded/)).toBeFocused()
    await expect(page.locator('header .brand img')).toHaveAttribute('src', /\/v1\/branding\/logo\?v=/)
    // The name: saved explicitly, and shown in the header.
    const name = page.getByLabel('Name of this installation')
    await name.fill('Acme Brain')
    await page.getByRole('button', { name: 'Save the name' }).click()
    await expect(status(page, 'Saved.')).toBeFocused()
    await expect(page.locator('header .brand .name')).toHaveText('Acme Brain')
    // Removing the logo asks first.
    await page.getByRole('button', { name: 'Remove the logo' }).click()
    await page
      .getByRole('dialog', { name: 'Remove the logo?' })
      .getByRole('button', { name: 'Remove the logo' })
      .click()
    await expect(
      status(page, 'Logo removed. The header shows the RSC mark; emails show the name only.'),
    ).toBeFocused()
    await expect(page.locator('header .brand img')).toHaveCount(0)
  })
})
