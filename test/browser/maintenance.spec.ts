// While an update runs (B7 PR35; spec «Actualizar»: writes wait, reads keep working, CA7b): one band on every page,
// from GET /v1/health when the web starts or from the first write refused with 503 under_maintenance; a save refused
// says so in its own form, and nothing is lost there; the band goes by itself once the update ends. And CA7 «the
// failure is seen on the web»: Admin › Backups & system says how the last update went, with the service's last lines.
import AxeBuilder from '@axe-core/playwright'
import { expect, scenario, test } from './fixture.ts'

const behind = (baseURL: string, id: string, change: Record<string, unknown>) =>
  fetch(`${baseURL}/__fixture/scenarios/${id}/admin-edit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(change),
  })

test.describe('maintenance across the web', () => {
  test('an update under way: a band on every page; reading works; it goes once the update ends', async ({
    page,
    context,
    baseURL,
  }) => {
    const { id } = await scenario(context, baseURL as string, 'signed-in')
    await behind(baseURL as string, id, { maintenance: true })
    await page.goto('/')
    const band = page.locator('[data-state="maintenance"]')
    await expect(band).toBeVisible()
    await expect(band).toHaveAttribute('role', 'status')
    await expect(band).toContainText('Reading works')
    // Reading keeps working, and the band stays from page to page.
    await page.goto('/b/growth')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(band).toBeVisible()
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
    // The update ends: the band goes by itself (the web looks again within half a minute).
    await behind(baseURL as string, id, { maintenance: false })
    await expect(band).toHaveCount(0, { timeout: 35_000 })
  })

  test('a save refused during the update says why in its form, keeps what was typed, and turns the band on', async ({
    page,
    context,
    baseURL,
  }) => {
    const { id } = await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/profile')
    const tokens = page.getByRole('region', { name: 'Tokens' })
    await tokens.getByRole('button', { name: 'Create a token' }).click()
    const form = tokens.getByRole('form', { name: 'New token' })
    await form.getByLabel('Name').fill('During the update')
    // The update starts after the page was read: the web learns it from the refusal.
    await behind(baseURL as string, id, { maintenance: true })
    await expect(page.locator('[data-state="maintenance"]')).toHaveCount(0)
    await form.getByRole('button', { name: 'Create token' }).click()
    await expect(form).toContainText('rsc-brain is under maintenance, retry after 20 seconds')
    await expect(form.getByLabel('Name')).toHaveValue('During the update')
    await expect(page.locator('[data-state="maintenance"]')).toBeVisible()
  })
})

test.describe('Admin › Backups & system: the last update (CA7)', () => {
  test('none yet; a good one says from and to; a failed one says it went back, with what the service said', async ({
    page,
    context,
    baseURL,
  }) => {
    const { id } = await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/system')
    const part = page.getByRole('region', { name: 'Backups' })
    const last = part.locator('[data-state="last-update"]')
    await expect(last).toContainText('None yet')
    await behind(baseURL as string, id, {
      lastUpdate: { ok: true, from: '0.1.0', to: '0.2.0', at: '2026-11-03T12:00:00.000Z' },
    })
    await page.reload()
    await expect(last).toContainText('Updated from 0.1.0 to 0.2.0.')
    await expect(part.locator('[data-state="update-failed"]')).toHaveCount(0)
    await behind(baseURL as string, id, {
      lastUpdate: {
        ok: false,
        from: '0.2.0',
        to: '0.3.0',
        at: '2026-11-03T13:00:00.000Z',
        log: 'Migration 0025_broken.sql failed: division by zero. Nothing of it was applied.',
      },
    })
    await page.reload()
    const failed = part.locator('[data-state="update-failed"]')
    await expect(failed).toContainText('The update from 0.2.0 to 0.3.0 failed')
    await expect(failed).toContainText('went back to 0.2.0')
    await failed.getByText('What the service said').click()
    await expect(failed.locator('pre')).toContainText('division by zero')
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
    // At 320 px the log wraps inside its box; the page never scrolls sideways.
    await page.setViewportSize({ width: 320, height: 800 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= 320)).toBe(true)
  })
})
