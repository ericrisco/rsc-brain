// Admin › Backups & system and the wizard's step «Installation key» (spec B7 «Copias y restauración», plan T018, T019;
// CA10 web) against the fixture API: the copies with their key id and «Needs the older key», a copy by hand that says
// when it ends, a download, a restore that says what it loses and asks the name and the password before anything,
// then «Restored. Everyone signs in again» on the sign-in page; the key only after the password, gone when hidden;
// the band at the top of the administration while the last copy failed, until a good one; the new release with what
// it changes; every state (loading, error, empty, off, too many), the keyboard, 320 px and axe.
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, noSideScroll, PASSWORD, scenario, test } from './fixture.ts'

const KEY = 'fixture-installation-key-0123456789abcdefghijklmnop'

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze()
  const bad = r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${where}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  expect(bad).toEqual([])
}

const behind = (baseURL: string, id: string, change: Record<string, unknown>) =>
  fetch(`${baseURL}/__fixture/scenarios/${id}/admin-edit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(change),
  })

test.describe('Admin › Backups & system: the copies', () => {
  test('the copies with their date, kind, size and key id; one made with an older key says so and is not restored here', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/system')
    const part = page.getByRole('region', { name: 'Backups' })
    await expect(part).toContainText('Last good copy')
    await expect(part).toContainText('Every day at 03:00 (Europe/Madrid), keeping the newest 14')
    await expect(part).toContainText('38.2 GB')
    const rows = part.locator('.copies > li')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toContainText('Daily')
    await expect(rows.nth(0)).toContainText('key fx12ab34cd56')
    await expect(rows.nth(2)).toContainText('By hand')
    await expect(rows.nth(2)).toContainText('Needs the older key')
    const old = rows.nth(2).getByRole('button', { name: /Restore the copy of/ })
    await expect(old).toHaveAttribute('aria-disabled', 'true')
    await expect(rows.nth(2)).toContainText('restore it on the machine with that key')
    await audit(page, 'backups')
  })

  test('a copy by hand: «Making a copy…» while it runs, then «Copy made» with the keyboard there, and it is listed first', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/system')
    const part = page.getByRole('region', { name: 'Backups' })
    const make = part.getByRole('button', { name: 'Make a copy now' })
    await make.focus()
    await page.keyboard.press('Enter')
    await expect(part.getByRole('button', { name: 'Making a copy…' })).toBeVisible()
    await expect(part.getByRole('status').filter({ hasText: 'Copy made:' })).toBeFocused()
    await expect(part.locator('.copies > li')).toHaveCount(4)
    await expect(part.locator('.copies > li').first()).toContainText('By hand')
  })

  test('CA10: a copy that fails shows a band on every page of the administration until a good copy', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await behind(baseURL as string, s.id, { backupFailure: 'disk_full', nextCopy: 'disk_full' })
    await page.goto('/admin/people')
    const band = page.getByRole('alert').filter({ hasText: 'The last copy failed' })
    await expect(band).toContainText('the disk of the copies is full')
    await expect(band.getByRole('link', { name: 'See Backups & system' })).toBeVisible()
    await page.goto('/admin/email')
    await expect(band).toBeVisible()
    await audit(page, 'band')
    await page.goto('/admin/system')
    // Another copy by hand fails again: the band stays.
    await page.getByRole('button', { name: 'Make a copy now' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'The copy did not finish' })).toBeFocused()
    await expect(band).toBeVisible()
    // A good copy: the band is gone.
    await page.getByRole('button', { name: 'Make a copy now' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Copy made:' })).toBeFocused()
    await page.goto('/admin/people')
    await expect(page.getByRole('heading', { level: 1, name: 'Administration' })).toBeVisible()
    await expect(page.getByText('The last copy failed')).toHaveCount(0)
  })

  test('a copy kept with a warning says so with its date', async ({ page, context, baseURL }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await behind(baseURL as string, s.id, { backupWarning: 'status_not_saved' })
    await page.goto('/admin/system')
    await expect(page.getByRole('note').filter({ hasText: 'Copy kept with a warning' })).toContainText(
      'its status could not be saved',
    )
  })

  test('downloading a copy is a plain link to the file', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/system')
    const link = page
      .locator('.copies > li')
      .first()
      .getByRole('link', { name: /Download the copy of/ })
    const href = String(await link.getAttribute('href'))
    expect(href).toMatch(/^\/v1\/admin\/backups\/rsc-brain-\d{8}T\d{6}Z-scheduled\/download$/)
    const res = await page.request.get(href)
    expect(res.headers()['content-disposition']).toMatch(/^attachment; filename="rsc-brain-.*\.rscb"$/)
  })

  test('every state: loading, error, no copies yet, no folder for copies, many copies', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in', { 'admin-backups': 'loading' })
    await page.goto('/admin/system')
    const part = page.getByRole('region', { name: 'Backups' })
    await expect(part.locator('[data-state="loading"]')).toBeVisible()
    await s.state('admin-backups', 'error')
    await page.reload()
    await expect(part.getByRole('button', { name: 'Try again' })).toBeVisible()
    await s.state('admin-backups', 'normal')
    await part.getByRole('button', { name: 'Try again' }).click()
    await expect(part.locator('.copies > li')).toHaveCount(3)

    const e = await scenario(context, baseURL as string, 'signed-in', { 'admin-backups': 'empty' })
    await page.goto('/admin/system')
    await expect(part).toContainText('No copies yet.')
    await expect(part).toContainText('The daily copy runs at 03:00; or make one now.')
    await expect(part).toContainText('None yet')
    await behind(baseURL as string, e.id, { backupsOff: true })
    await page.reload()
    await expect(part).toContainText('No folder for copies is set')
    await expect(part).toContainText('RSC_BRAIN_BACKUPS')
    await expect(part.getByRole('button', { name: 'Make a copy now' })).toHaveCount(0)

    await scenario(context, baseURL as string, 'signed-in', { 'admin-backups': 'much-data' })
    await page.goto('/admin/system')
    await expect(part.locator('.copies > li')).toHaveCount(10)
    await part.getByRole('button', { name: 'Show all 40 copies' }).click()
    await expect(part.locator('.copies > li')).toHaveCount(40)
  })

  test('offline: the copy and the restore wait, and say why', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/system')
    await expect(page.locator('.copies > li')).toHaveCount(3)
    await context.setOffline(true)
    await page.evaluate(() => window.dispatchEvent(new Event('offline')))
    await expect(page.getByRole('button', { name: 'Make a copy now' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await expect(
      page
        .locator('.copies > li')
        .first()
        .getByRole('button', { name: /Restore the copy of/ }),
    ).toHaveAttribute('aria-disabled', 'true')
    await context.setOffline(false)
  })

  test('only the administration: a member sees why, and no copy', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'member')
    await page.goto('/admin/system')
    await expect(page.getByText('Only the administration of this installation opens this.')).toBeVisible()
    await expect(page.locator('.copies')).toHaveCount(0)
  })

  test('320 px: nothing scrolls sideways, the restore dialog included', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await behind(baseURL as string, s.id, {
      backupFailure: 'no_permission',
      release: { latest: 'v0.2.0', notes: 'x'.repeat(400), checkedAt: '2026-10-29T08:00:00.000Z' },
    })
    await page.setViewportSize({ width: 320, height: 700 })
    await page.goto('/admin/system')
    await expect(page.locator('.copies > li')).toHaveCount(3)
    await noSideScroll(page)
    await page
      .locator('.copies > li')
      .first()
      .getByRole('button', { name: /Restore the copy of/ })
      .click()
    await expect(page.getByLabel('Name of this installation')).toBeVisible()
    await noSideScroll(page)
    await audit(page, 'restore dialog at 320')
  })
})

test.describe('Admin › Backups & system: restoring', () => {
  test('risk 9: says what is lost, asks the name and the password, then «Restored. Everyone signs in again»', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/system')
    await page
      .locator('.copies > li')
      .first()
      .getByRole('button', { name: /Restore the copy of/ })
      .click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Everything here is replaced by this copy')
    await expect(dialog).toContainText('What was written after it is lost: the last write here was')
    await expect(dialog).toContainText('First, rsc-brain makes a copy of what is here now')
    await expect(dialog).toContainText('everyone signs in again')
    await audit(page, 'restore')
    // Nothing goes until the name and the password are there.
    let sent = 0
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/restore$/.test(r.url())) sent++
    })
    await dialog.getByRole('button', { name: 'Restore this copy' }).click()
    await expect(dialog.getByLabel('Name of this installation')).toBeFocused()
    await expect(dialog).toContainText('Type the name of this installation: rsc-brain')
    expect(sent).toBe(0)
    // A name not exactly the installation's.
    await dialog.getByLabel('Name of this installation').fill('RSC-brain')
    await dialog.getByLabel('Your password').fill(PASSWORD)
    await dialog.getByRole('button', { name: 'Restore this copy' }).click()
    await expect(dialog).toContainText('Type the name exactly as it is: rsc-brain')
    expect(sent).toBe(0)
    // A wrong password: said on the field, nothing restored, still signed in.
    await dialog.getByLabel('Name of this installation').fill('rsc-brain')
    await dialog.getByLabel('Your password').fill('not the password')
    await dialog.getByRole('button', { name: 'Restore this copy' }).click()
    await expect(dialog).toContainText('The password is not right.')
    await expect(dialog.getByLabel('Your password')).toBeFocused()
    await expect(dialog.getByLabel('Your password')).toHaveValue('')
    await expect(page).toHaveURL(/\/admin\/system$/)
    // Right: restored, then to sign in, with the words.
    await dialog.getByLabel('Your password').fill(PASSWORD)
    await dialog.getByRole('button', { name: 'Restore this copy' }).click()
    await expect(page).toHaveURL(/\/sign-in$/)
    await expect(
      page.getByRole('status').filter({ hasText: 'Restored. Everyone signs in again' }),
    ).toBeVisible()
    await expect(page.getByText('Your session ended')).toHaveCount(0)
    expect((await page.request.get('/v1/me')).status()).toBe(401)
  })

  test('while a restore is running the dialog stays (Esc, Close, backdrop); its answer is shown; Restore opens again', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    let release: () => void = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    await page.route('**/v1/admin/backups/*/restore', async (route) => {
      await held
      await route.fulfill({
        status: 409,
        json: {
          error: {
            code: 'backup_running',
            message: 'A copy is being made right now (the daily one).',
            howToProceed: 'Try again when it ends.',
          },
        },
      })
    })
    await page.goto('/admin/system')
    const open = page
      .locator('.copies > li')
      .first()
      .getByRole('button', { name: /Restore the copy of/ })
    await open.click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Name of this installation').fill('rsc-brain')
    await dialog.getByLabel('Your password').fill(PASSWORD)
    await dialog.getByRole('button', { name: 'Restore this copy' }).click()
    await expect(dialog.getByRole('button', { name: /Restoring/ })).toBeVisible()
    // Twice: the browser lets a second Esc close a dialog whose first was refused (close watchers).
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: /Restoring/ })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Close' })).toHaveAttribute('aria-disabled', 'true')
    await dialog.getByRole('button', { name: 'Close' }).click({ force: true })
    await page.mouse.click(5, 5)
    await expect(dialog).toBeVisible()
    release()
    await expect(dialog).toContainText('A copy is being made right now (the daily one).')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await open.click()
    await expect(page.getByRole('dialog').getByLabel('Name of this installation')).toBeVisible()
  })

  test('Esc keeps things as they are; the keyboard goes back to the button that opened it', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/system')
    const open = page
      .locator('.copies > li')
      .first()
      .getByRole('button', { name: /Restore the copy of/ })
    await open.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByLabel('Name of this installation')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(open).toBeFocused()
  })
})

test.describe('Admin › Backups & system: the installation key', () => {
  test('only after the password; copy, download, then hidden and gone from the page', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/system')
    const part = page.getByRole('region', { name: 'Installation key' })
    await expect(part).toContainText('fx12ab34cd56')
    await expect(page.locator('body')).not.toContainText(KEY)
    await part.getByRole('button', { name: 'Show the installation key…' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel('Your password')).toBeFocused()
    await dialog.getByRole('button', { name: 'Show the key' }).click()
    await expect(dialog).toContainText('Type your password.')
    await dialog.getByLabel('Your password').fill('wrong one')
    await dialog.getByRole('button', { name: 'Show the key' }).click()
    await expect(dialog).toContainText('The password is not right.')
    await expect(page).toHaveURL(/\/admin\/system$/)
    await expect(page.locator('body')).not.toContainText(KEY)
    await dialog.getByLabel('Your password').fill(PASSWORD)
    await dialog.getByRole('button', { name: 'Show the key' }).click()
    await expect(dialog).toContainText(KEY)
    await expect(dialog.getByRole('button', { name: 'Copy the key' })).toBeFocused()
    const download = page.waitForEvent('download')
    await dialog.getByRole('link', { name: 'Download the key (.txt)' }).click()
    const file = await download
    expect(file.suggestedFilename()).toBe('rsc-brain-key-rsc-brain-fx12ab34cd56.txt')
    const path = await file.path()
    const { readFile } = await import('node:fs/promises')
    expect((await readFile(path, 'utf8')).trim()).toBe(KEY)
    await audit(page, 'key shown')
    await dialog.getByRole('button', { name: 'Done, hide the key' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'The key is hidden' })).toBeFocused()
    await expect(page.locator('body')).not.toContainText(KEY)
  })

  test('a one-time secret: put away (pagehide), the key shown is forgotten', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/system')
    await page.getByRole('button', { name: 'Show the installation key…' }).click()
    await page.getByRole('dialog').getByLabel('Your password').fill(PASSWORD)
    await page.getByRole('dialog').getByRole('button', { name: 'Show the key' }).click()
    await expect(page.getByRole('dialog')).toContainText(KEY)
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
    await expect(page.locator('body')).not.toContainText(KEY)
    // Opened again, it asks the password again: nothing was kept.
    await page.getByRole('button', { name: 'Show the installation key…' }).click()
    await expect(page.getByRole('dialog').getByLabel('Your password')).toBeVisible()
    await expect(page.locator('body')).not.toContainText(KEY)
  })

  test('with a second factor the code is asked too', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.route('**/v1/me', async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      body.account.totp = true
      await route.fulfill({ response: res, json: body })
    })
    await page.goto('/admin/system')
    await page.getByRole('button', { name: 'Show the installation key…' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Your password').fill(PASSWORD)
    await dialog.getByRole('button', { name: 'Show the key' }).click()
    await expect(dialog.getByLabel('Code from your authenticator app')).toBeFocused()
  })
})

test.describe('Admin › Backups & system: the version', () => {
  test('a newer version says so in the exact words, with what it changes and how to update; none checked says so', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/system')
    const service = page.getByRole('region', { name: 'Service' })
    await expect(service).toContainText('Version v0.1.0 is running. Not checked for a new version yet.')
    await behind(baseURL as string, s.id, {
      release: { latest: 'v0.2.0', notes: '- Faster search.', checkedAt: new Date().toISOString() },
    })
    await page.reload()
    await expect(service).toContainText('Version v0.1.0 is running. Version v0.2.0 is available.')
    await service.getByText('What changes in v0.2.0').click()
    await expect(service).toContainText('- Faster search.')
    await expect(service).toContainText('rsc-brain.sh update')
  })

  test('the newest says so; ahead of what is published says that, not that a new one exists', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await behind(baseURL as string, s.id, {
      release: { latest: 'v0.1.0', notes: '', checkedAt: new Date().toISOString() },
    })
    await page.goto('/admin/system')
    const service = page.getByRole('region', { name: 'Service' })
    await expect(service).toContainText('Version v0.1.0 is running. This is the newest.')
    await behind(baseURL as string, s.id, {
      release: { latest: 'v0.0.9', notes: '', checkedAt: new Date().toISOString() },
    })
    await page.reload()
    await expect(service).toContainText('ahead of the newest published version (v0.0.9)')
    await expect(service).not.toContainText('This is the newest')
  })

  test('a private repository: Could not check, with the command; never up to date, even if it knew the answer before', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    const at = new Date().toISOString()
    await behind(baseURL as string, s.id, {
      release: { latest: null, notes: null, checkedAt: null, error: 'no_access', lastAttemptAt: at },
    })
    await page.goto('/admin/system')
    const service = page.getByRole('region', { name: 'Service' })
    await expect(service).toContainText('Could not check for a new version')
    await expect(service).toContainText('Version v0.1.0 is running.')
    await expect(service.locator('code', { hasText: 'rsc-brain.sh update --check' })).toBeVisible()
    // The last answer was days ago, the last try minutes ago: «Tried» says the try.
    const days = new Date(Date.now() - 3 * 86_400_000).toISOString()
    const minutes = new Date(Date.now() - 5 * 60_000).toISOString()
    await behind(baseURL as string, s.id, {
      release: { latest: 'v0.1.0', notes: '', checkedAt: days, error: 'network', lastAttemptAt: minutes },
    })
    await page.reload()
    await expect(service).toContainText('Could not check for a new version')
    await expect(service).not.toContainText('This is the newest')
    await expect(service).toContainText('Tried 5 min ago.')
    await expect(service).not.toContainText('3 days ago')
  })

  test('a newer version it knew stays said when the last check failed', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    const at = new Date().toISOString()
    await behind(baseURL as string, s.id, {
      release: { latest: 'v0.2.0', notes: '- Two.', checkedAt: at, error: 'network', lastAttemptAt: at },
    })
    await page.goto('/admin/system')
    const service = page.getByRole('region', { name: 'Service' })
    await expect(service).toContainText('Version v0.1.0 is running. Version v0.2.0 is available.')
    await expect(service).not.toContainText('Could not check')
    await expect(service).toContainText('Checked')
  })

  test('no version published says that, not a failure', async ({ page, context, baseURL }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    const at = new Date().toISOString()
    await behind(baseURL as string, s.id, {
      release: { latest: null, notes: null, checkedAt: at, error: 'none', lastAttemptAt: at },
    })
    await page.goto('/admin/system')
    const service = page.getByRole('region', { name: 'Service' })
    await expect(service).toContainText('Cannot update: no published version yet')
    await expect(service).not.toContainText('Could not check')
  })
})

test.describe('first-time setup: the step «Installation key»', () => {
  test('see it, copy it, download it, tick that it is saved, then in; a reload does not show it again', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'fresh')
    await page.goto('/setup')
    await page.getByLabel('Name of this installation').fill('Acme')
    await page.getByLabel('Your name').fill('Ada')
    await page.getByLabel('Your email').fill('ada@example.test')
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Set up and sign in' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Keep the installation key' })).toBeFocused()
    await expect(page.locator('pre')).toContainText(KEY)
    await expect(page.getByText('Key id: fx12ab34cd56')).toBeVisible()
    await audit(page, 'key step')
    const download = page.waitForEvent('download')
    await page.getByRole('link', { name: 'Download the key (.txt)' }).click()
    expect((await download).suggestedFilename()).toBe('rsc-brain-key-acme-fx12ab34cd56.txt')
    // Not before it is saved.
    const go = page.getByRole('button', { name: 'Continue to rsc-brain' })
    await expect(go).toHaveAttribute('aria-disabled', 'true')
    await go.click({ force: true })
    await expect(
      page.getByLabel('I saved the installation key somewhere safe, outside this machine'),
    ).toBeFocused()
    await page.keyboard.press('Space')
    await go.click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.locator('body')).not.toContainText(KEY)
    // Shown once: the server says it was given.
    const again = await page.request.post('/v1/setup/key', {
      headers: { 'x-requested-with': 'rsc-brain-web' },
      data: {},
    })
    expect(again.status()).toBe(404)
  })

  test('a one-time secret: put away (pagehide), the key of the step is forgotten', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'fresh')
    await page.goto('/setup')
    await page.getByLabel('Name of this installation').fill('Acme')
    await page.getByLabel('Your name').fill('Ada')
    await page.getByLabel('Your email').fill('ada@example.test')
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Set up and sign in' }).click()
    await expect(page.locator('pre')).toContainText(KEY)
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
    await expect(page.locator('body')).not.toContainText(KEY)
    await expect(page.getByRole('heading', { level: 1, name: 'The key was already shown' })).toBeVisible()
    await expect(page.getByText('Administration › Backups & system')).toBeVisible()
  })

  test('the key cannot be read (a failure): try again, or go on and download it later', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'fresh')
    await page.route('**/v1/setup/key', (route) =>
      route.fulfill({
        status: 500,
        json: {
          error: {
            code: 'internal',
            message: 'Something went wrong on the server.',
            howToProceed: 'Try again.',
          },
        },
      }),
    )
    await page.goto('/setup')
    await page.getByLabel('Name of this installation').fill('Acme')
    await page.getByLabel('Your name').fill('Ada')
    await page.getByLabel('Your email').fill('ada@example.test')
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Set up and sign in' }).click()
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
    await expect(page.getByText('You can download the key later in Admin › Backups & system')).toBeVisible()
    await page.getByRole('button', { name: 'Continue to rsc-brain' }).click()
    await expect(page).toHaveURL(/\/$/)
  })

  test('320 px and keyboard on the step', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'fresh')
    await page.setViewportSize({ width: 320, height: 700 })
    await page.goto('/setup')
    await page.getByLabel('Name of this installation').fill('Acme')
    await page.getByLabel('Your name').fill('Ada')
    await page.getByLabel('Your email').fill('ada@example.test')
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.keyboard.press('Enter')
    await expect(page.locator('pre')).toContainText(KEY)
    await noSideScroll(page)
  })
})
