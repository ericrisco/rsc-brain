// Updating from the web (rsc-updates B3: CA27, CA28), against the fixture API. Admin › Backups & system, the part
// «Version»: the button only when an updater runs and a newer version exists; the password asked again (and the code
// with a second factor) in a dialog, a wrong one said on the field; what is sent is the password and nothing else; the
// request, the update running, the result in the exact words, a failure with «Try again» (or the command, when only the
// server can), and, in an installation made by rsc-factory, no button and a way to rsc-factory. By keyboard, and at
// 320 px without scrolling sideways.
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, noSideScroll, PASSWORD, scenario, test } from './fixture.ts'

const behind = (baseURL: string, id: string, change: Record<string, unknown>) =>
  fetch(`${baseURL}/__fixture/scenarios/${id}/admin-edit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(change),
  })

const NEWER = { latest: 'v0.2.0', notes: '- Faster search.', checkedAt: '2026-10-29T08:00:00.000Z' }
const failure = (retries: number, retryFrom: string | null) => ({
  version: 'v0.2.0',
  failedAt: '2026-10-29T09:30:00.000Z',
  reason: 'the image did not build',
  retries,
  retryFrom,
})
const PAST = '2020-01-01T00:00:00.000Z'
const FUTURE = '2999-01-01T00:00:00.000Z'

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze()
  const bad = r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${where}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  expect(bad).toEqual([])
}

const service = (page: Page) => page.getByRole('region', { name: 'Service' })

test.describe('Admin › Backups & system: updating from the web', () => {
  test('off: the command, and no button, even with a newer version', async ({ page, context, baseURL }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await behind(baseURL as string, s.id, { release: NEWER })
    await page.goto('/admin/system')
    await expect(service(page)).toContainText('Version v0.1.0 is running. Version v0.2.0 is available.')
    await expect(service(page)).toContainText('rsc-brain.sh update')
    await expect(page.getByRole('button', { name: /^Update to/ })).toHaveCount(0)
  })

  test('on and a newer version: the button, the password asked again, a wrong one said, then requested; only the password is sent', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await behind(baseURL as string, s.id, { release: NEWER, update: { mode: 'on' } })
    await page.goto('/admin/system')
    await expect(service(page)).toContainText('Version v0.1.0 is running. Version v0.2.0 is available.')
    await audit(page, 'update available')
    // By keyboard: the button is reached and opens the dialog; the password has the focus.
    const button = service(page).getByRole('button', { name: 'Update to v0.2.0' })
    await button.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Update to v0.2.0')
    await expect(dialog).toContainText('goes back to the version you have now')
    await expect(dialog.getByLabel('Your password')).toBeFocused()
    await audit(page, 'update dialog')
    // Nothing typed.
    await dialog.getByRole('button', { name: 'Update to v0.2.0' }).click()
    await expect(dialog).toContainText('Type your password.')
    await expect(dialog.getByLabel('Your password')).toBeFocused()
    // A wrong one.
    await dialog.getByLabel('Your password').fill('not the password')
    await page.keyboard.press('Enter')
    await expect(dialog).toContainText('The password is not right.')
    await expect(dialog.getByLabel('Your password')).toBeFocused()
    await expect(dialog.getByLabel('Your password')).toHaveValue('')
    // The right one: the request carries the password and nothing else.
    await dialog.getByLabel('Your password').fill(PASSWORD)
    const sent = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/v1/admin/update'))
    await page.keyboard.press('Enter')
    expect(Object.keys((await sent).postDataJSON())).toEqual(['password'])
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const said = page.getByRole('status').filter({ hasText: 'Update requested.' })
    await expect(said).toBeFocused()
    // The page follows: the request waits for the updater, then it runs, then the result.
    await expect(service(page)).toContainText('waits for the updater')
    await expect(page.getByRole('button', { name: /^Update to/ })).toHaveCount(0)
    await behind(baseURL as string, s.id, {
      update: { requested: false, running: { to: 'v0.2.0', startedAt: '2026-10-29T10:00:00.000Z' } },
    })
    await expect(service(page)).toContainText('Updating to v0.2.0.', { timeout: 10_000 })
    await audit(page, 'update running')
    await behind(baseURL as string, s.id, {
      release: { latest: 'v0.1.0', notes: '', checkedAt: '2026-10-29T10:05:00.000Z' },
      update: { running: null },
      lastUpdate: { ok: true, from: 'v0.0.9', to: 'v0.1.0', at: '2026-10-29T10:04:00.000Z' },
    })
    await expect(service(page)).toContainText('Updated from v0.0.9 to v0.1.0.', { timeout: 10_000 })
    await expect(service(page)).toContainText('This is the newest')
  })

  test('with a second factor the code is asked, and sent', async ({ page, context, baseURL }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await behind(baseURL as string, s.id, { release: NEWER, update: { mode: 'on' } })
    await page.route('**/v1/me', async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      body.account.totp = true
      await route.fulfill({ response: res, json: body })
    })
    await page.goto('/admin/system')
    await service(page).getByRole('button', { name: 'Update to v0.2.0' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Your password').fill(PASSWORD)
    await dialog.getByRole('button', { name: 'Update to v0.2.0' }).click()
    await expect(dialog.getByLabel('Code from your authenticator app')).toBeFocused()
    await expect(dialog).toContainText('Type the 6 digits')
    await dialog.getByLabel('Code from your authenticator app').fill('424242')
    const sent = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/v1/admin/update'))
    await dialog.getByRole('button', { name: 'Update to v0.2.0' }).click()
    expect((await sent).postDataJSON()).toEqual({ password: PASSWORD, code: '424242' })
  })

  test('someone else asked first: the refusal is said in the dialog, nothing hidden', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await behind(baseURL as string, s.id, { release: NEWER, update: { mode: 'on' } })
    await page.goto('/admin/system')
    await service(page).getByRole('button', { name: 'Update to v0.2.0' }).click()
    // Meanwhile another administrator asks.
    await behind(baseURL as string, s.id, { update: { requested: true } })
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Your password').fill(PASSWORD)
    await page.keyboard.press('Enter')
    await expect(dialog.getByRole('alert')).toContainText('An update is already running.')
  })

  test('a failure: when, why, and Try again; it asks the password again too', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await behind(baseURL as string, s.id, {
      release: NEWER,
      update: { mode: 'on', attempts: [failure(0, PAST)] },
    })
    await page.goto('/admin/system')
    await expect(service(page)).toContainText('The update to v0.2.0 failed at')
    await service(page).getByText('What the updater said').click()
    await expect(service(page)).toContainText('the image did not build')
    await expect(service(page).getByRole('button', { name: /^Update to/ })).toHaveCount(0)
    await audit(page, 'update failed')
    await service(page).getByRole('button', { name: 'Try again' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Your password').fill(PASSWORD)
    const sent = page.waitForRequest(
      (r) => r.method() === 'POST' && r.url().endsWith('/v1/admin/update/retry'),
    )
    await dialog.getByRole('button', { name: 'Try again' }).click()
    expect(Object.keys((await sent).postDataJSON())).toEqual(['password'])
    await expect(page.getByRole('status').filter({ hasText: 'Update requested.' })).toBeFocused()
  })

  test('too soon to try again: said with when, no button; past the limit: only the server, with the command', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await behind(baseURL as string, s.id, {
      release: NEWER,
      update: { mode: 'on', attempts: [failure(1, FUTURE)] },
    })
    await page.goto('/admin/system')
    await expect(service(page)).toContainText('You can try again')
    await expect(service(page).getByRole('button', { name: 'Try again' })).toHaveCount(0)
    await behind(baseURL as string, s.id, { update: { attempts: [failure(3, null)] } })
    await page.reload()
    await expect(service(page)).toContainText('only the server can try again')
    await expect(service(page)).toContainText('rsc-brain.sh update')
    await expect(service(page).getByRole('button', { name: 'Try again' })).toHaveCount(0)
  })

  test('installed by rsc-factory: no button of its own, and the way to rsc-factory (CA28)', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await behind(baseURL as string, s.id, {
      release: NEWER,
      update: { mode: 'companion', factoryUrl: 'https://factory.example.test' },
    })
    await page.goto('/admin/system')
    await expect(service(page)).toContainText('Version v0.1.0 is running. Version v0.2.0 is available.')
    await expect(service(page)).toContainText('rsc-brain was installed by rsc-factory: update it from there.')
    await expect(service(page).getByRole('link', { name: 'Open rsc-factory' })).toHaveAttribute(
      'href',
      'https://factory.example.test',
    )
    await expect(page.getByRole('button', { name: /^Update to|Try again/ })).toHaveCount(0)
    await expect(service(page)).not.toContainText('Update on the machine')
    await audit(page, 'companion')
  })

  test('at 320 px nothing scrolls sideways, in each state', async ({ page, context, baseURL }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.setViewportSize({ width: 320, height: 700 })
    const states: Array<Record<string, unknown>> = [
      { mode: 'on' },
      { mode: 'on', requested: true },
      { mode: 'on', running: { to: 'v0.2.0', startedAt: null } },
      { mode: 'on', attempts: [failure(0, PAST)] },
      { mode: 'on', attempts: [failure(1, FUTURE)] },
      { mode: 'on', attempts: [failure(3, null)] },
      { mode: 'companion', factoryUrl: 'https://factory.example.test/with/a/long/path/to/admin/updates' },
    ]
    for (const update of states) {
      await behind(baseURL as string, s.id, {
        release: NEWER,
        update: { mode: 'off', requested: false, running: null, attempts: [], ...update },
      })
      await page.goto('/admin/system')
      await expect(service(page)).toContainText('Version v0.1.0 is running.')
      await noSideScroll(page)
    }
    await behind(baseURL as string, s.id, {
      update: { mode: 'on', requested: false, running: null, attempts: [] },
    })
    await page.goto('/admin/system')
    await service(page).getByRole('button', { name: 'Update to v0.2.0' }).click()
    await expect(page.getByRole('dialog').getByLabel('Your password')).toBeVisible()
    await noSideScroll(page)
  })
})
