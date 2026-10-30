// Spec B6 CA16 (for the screens of PR17): an automatic accessibility audit finds nothing serious or
// critical, in the dark theme and in the light one. And the web answers with the headers of plan §0.
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, INVITE, RESET, scenario, test } from './fixture.ts'

// WCAG A and AA, and the best-practice rules (a dialog without a name, a page without one main landmark
// or level-one heading, content outside a landmark): serious and critical ones fail the test.
async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze()
  const bad = r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${where}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  expect(bad).toEqual([])
}

for (const theme of ['dark', 'light'] as const) {
  test(`signed-out screens, ${theme}`, async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-out')
    await page.addInitScript((t) => localStorage.setItem('rscb.theme', t), theme)
    for (const path of [
      '/sign-in',
      '/reset',
      `/reset#token=${RESET}`,
      `/invite#token=${INVITE}`,
      '/invite',
    ]) {
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1 }).or(page.getByRole('alert')).first()).toBeVisible()
      await audit(page, `${theme} ${path}`)
    }
    await page.goto('/sign-in')
    await page.getByLabel('Email').fill('eric@example.test')
    await page.getByLabel('Password').fill('wrong one here')
    await page.getByLabel('Password').press('Enter')
    await expect(page.getByRole('alert')).toBeVisible()
    await audit(page, `${theme} sign-in with an error`)
  })

  test(`first run, ${theme}`, async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'fresh')
    await page.addInitScript((t) => localStorage.setItem('rscb.theme', t), theme)
    await page.goto('/setup')
    await expect(page.getByRole('heading', { name: 'Set up rsc-brain' })).toBeVisible()
    await audit(page, `${theme} setup`)
  })

  test(`signed-in screens and dialogs, ${theme}`, async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.addInitScript((t) => localStorage.setItem('rscb.theme', t), theme)
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'Growth' })).toBeVisible()
    await audit(page, `${theme} home`)
    await page.goto('/b/growth')
    await expect(page.getByRole('heading', { name: 'Growth' })).toBeVisible()
    await audit(page, `${theme} brain`)
    await page.keyboard.press('?')
    // Each dialog has its name, and is open before it is audited.
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
    await audit(page, `${theme} help`)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.locator('html[data-keys="on"]').waitFor({ state: 'attached' })
    await page.keyboard.press('Control+k')
    const search = page.getByRole('dialog', { name: 'Search' })
    await expect(search).toBeVisible()
    await audit(page, `${theme} search`)
    await search.getByLabel('Search all your brains').fill('retention')
    await search.getByLabel('Search all your brains').press('Enter')
    await expect(search.getByText(/\d+ results/)).toBeVisible()
    await audit(page, `${theme} search with results`)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Menu' }).click()
    await expect(page.getByRole('dialog', { name: 'Growth' })).toBeVisible()
    await audit(page, `${theme} brain menu`)
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.getByRole('button', { name: /Account/ }).click()
    await audit(page, `${theme} account menu`)
  })
}

// The screens of PR18: home empty with its first steps, the overview of a new brain, people with a link
// shown, and their dialogs (create a brain, connect your agent, withdraw an invitation).
for (const theme of ['dark', 'light'] as const) {
  test(`home, overview and people (PR18), ${theme}`, async ({ page, context, baseURL }) => {
    // Six full axe audits in one walk: about 3 s alone, but past 30 s when eight workers share the
    // machine (seen in --repeat-each runs). The budget, not the page, is what ran out.
    test.slow()
    await scenario(context, baseURL as string, 'alone', {}, { mail: false })
    await page.addInitScript((t) => localStorage.setItem('rscb.theme', t), theme)
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible()
    await audit(page, `${theme} home get started`)
    await page.getByRole('button', { name: 'Create brain' }).first().click()
    await expect(page.getByRole('dialog', { name: 'Create a brain' })).toBeVisible()
    await audit(page, `${theme} create brain`)
    await page.getByLabel('Name').fill('Onboarding')
    await page.getByRole('dialog').getByRole('button', { name: 'Create brain' }).click()
    await expect(page.getByRole('region', { name: 'First steps' })).toBeVisible()
    await audit(page, `${theme} overview first steps`)
    await page
      .getByRole('region', { name: 'First steps' })
      .getByRole('button', { name: 'Connect your agent' })
      .click()
    await expect(page.getByRole('dialog', { name: 'Connect your agent' })).toBeVisible()
    await audit(page, `${theme} connect`)
    await page.keyboard.press('Escape')
    await page.goto('/people')
    await page.getByLabel('Emails').fill('zoe@example.test')
    await page.getByRole('button', { name: 'Create invitation link' }).click()
    await expect(page.getByRole('region', { name: 'Links to send' })).toBeVisible()
    await audit(page, `${theme} people with a link`)
    await page.getByRole('button', { name: 'Withdraw' }).first().click()
    await expect(page.getByRole('dialog', { name: 'Withdraw the invitation?' })).toBeVisible()
    await audit(page, `${theme} withdraw`)
  })

  test(`home with brains and the overview at work, ${theme}`, async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.addInitScript((t) => localStorage.setItem('rscb.theme', t), theme)
    await page.goto('/')
    await expect(page.getByText('3 proposals to review')).toBeVisible()
    await audit(page, `${theme} home cards`)
    await page.goto('/b/growth')
    await expect(page.getByRole('region', { name: "Today's sessions" })).toBeVisible()
    await audit(page, `${theme} overview`)
  })
}

test('the web carries the security headers of plan §0', async ({ request }) => {
  for (const path of ['/', '/sign-in', '/b/growth']) {
    const res = await request.get(path)
    expect(res.status()).toBe(200)
    const h = res.headers()
    expect(h['content-security-policy']).toContain("script-src 'self'")
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(h['x-frame-options']).toBe('DENY')
    expect(h['referrer-policy']).toBe('same-origin')
    expect(h['x-content-type-options']).toBe('nosniff')
    expect(h['cache-control']).toBe('no-cache')
  }
})
