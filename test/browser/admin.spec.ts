// The administration of people, invitations and service accounts (spec B6 «Admin», plan T047; PR25a),
// against the fixture API: each person with their role in each brain, last access and status; rights
// given and taken (the last administrator stays, and the screen says why); deactivating and
// reactivating; invitations by status, a link to copy; service accounts with their brains, main keys
// shown once, rotated and revoked, and the short keys live with their references. Only the
// administration reaches it.
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

const person = (page: Page, text: string) =>
  page
    .getByRole('region', { name: 'People in this installation' })
    .getByRole('listitem')
    .filter({ hasText: text })

test.describe('administration: people', () => {
  test('reached from the account menu; each person with roles by brain, last access and status', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/')
    await page.getByRole('button', { name: /Account/ }).click()
    await page.locator('#account-menu').getByRole('link', { name: 'Administration' }).click()
    await expect(page).toHaveURL(/\/admin\/people$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Administration' })).toBeVisible()
    const nav = page.getByRole('navigation', { name: 'Administration' })
    await expect(nav.getByRole('link', { name: 'People' })).toHaveAttribute('aria-current', 'page')
    const ana = person(page, 'ana@example.test')
    await expect(ana).toContainText('Growth (contributor) · Support (reader) · Legal archive (reader)')
    await expect(ana).toContainText('last seen')
    await expect(ana).toContainText('active')
    const eric = person(page, 'eric@example.test')
    await expect(eric).toContainText('Only administrator')
    await audit(page, 'admin people')
  })

  test('the last administrator cannot step down; with a second one, they can', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/people')
    const eric = person(page, 'eric@example.test')
    await expect(eric.getByRole('button', { name: 'Remove administrator rights from Eric' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await expect(eric).toContainText('The installation always keeps an administrator')
    const ana = person(page, 'ana@example.test')
    await ana.getByRole('button', { name: 'Make administrator: Ana' }).click()
    // Asked first, saying what it gives.
    const dialog = page.getByRole('dialog', { name: 'Make Ana an administrator?' })
    await expect(dialog).toContainText('can delete brains')
    await dialog.getByRole('button', { name: 'Make administrator: Ana' }).click()
    // The keyboard lands on what the change says, not on the page.
    await expect(page.getByRole('status').filter({ hasText: 'Ana is now an administrator.' })).toBeFocused()
    await expect(
      eric.getByRole('button', { name: 'Remove administrator rights from Eric' }),
    ).not.toHaveAttribute('aria-disabled', 'true')
    // Removing my own rights: asked, then the administration closes and says why.
    // A refusal does not throw me out.
    await page.route('**/v1/admin/accounts/acc_eric', (r) =>
      r.request().method() === 'PATCH'
        ? r.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({
              error: { code: 'internal', message: 'Boom.', howToProceed: 'Try again.' },
            }),
          })
        : r.continue(),
    )
    await eric.getByRole('button', { name: 'Remove administrator rights from Eric' }).click()
    const self = page.getByRole('dialog', { name: 'Remove your administrator rights?' })
    await expect(self).toContainText('leave the administration')
    await self.getByRole('button', { name: 'Remove my administrator rights' }).click()
    await expect(eric.getByRole('alert')).toContainText('Boom.')
    await expect(page.getByRole('navigation', { name: 'Administration' })).toBeVisible()
    await page.unroute('**/v1/admin/accounts/acc_eric')
    await eric.getByRole('button', { name: 'Remove administrator rights from Eric' }).click()
    await page
      .getByRole('dialog', { name: 'Remove your administrator rights?' })
      .getByRole('button', { name: 'Remove my administrator rights' })
      .click()
    await expect(page.locator('[data-state="forbidden"]')).toContainText(
      'You removed your own administrator rights',
    )
    // Said once: coming back later reads as any other refusal.
    await page.goto('/admin/services')
    await expect(page.locator('[data-state="forbidden"]')).toContainText('Only the administration')
    await page.getByRole('button', { name: /Account/ }).click()
    await expect(page.locator('#account-menu').getByRole('link', { name: 'Administration' })).toHaveCount(0)
  })

  test('find people by name, email or status; a filter with nothing offers to clear it; many people go by pages', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', { people: 'much-data' })
    await page.goto('/admin/people')
    const list = page.getByRole('region', { name: 'People in this installation' })
    await expect(list.locator('li[data-person]')).toHaveCount(20)
    await list.getByRole('button', { name: /Show 20 more/ }).click()
    await expect(list.locator('li[data-person]')).toHaveCount(40)
    // The keyboard goes to the first person just shown; after the last page too (the button is gone).
    await expect(list.locator('li[data-person]').nth(20)).toBeFocused()
    await list.getByRole('button', { name: /more/ }).click()
    await expect(list.locator('li[data-person]')).toHaveCount(47)
    await expect(list.locator('li[data-person]').nth(40)).toBeFocused()
    await list.getByLabel('Find by name or email').fill('person41@')
    await expect(list.locator('li[data-person]')).toHaveCount(1)
    await list.getByLabel('Find by name or email').fill('ana@')
    await expect(list.locator('li[data-person]')).toHaveCount(1)
    await list.getByLabel('Status').selectOption('removed')
    await expect(list.locator('[data-state="filtered-empty"]')).toContainText('No results for these filters.')
    await list.getByRole('button', { name: 'Clear filters' }).click()
    await expect(list.getByLabel('Find by name or email')).toBeFocused()
    await expect(list.locator('li[data-person]')).toHaveCount(20)
  })

  test('let someone create brains, and stop it', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/people')
    const ana = person(page, 'ana@example.test')
    await ana.getByRole('button', { name: 'Let create brains: Ana' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Ana can create brains.' })).toBeFocused()
    await ana.getByRole('button', { name: 'Stop creating brains: Ana' }).click()
    await expect(
      page.getByRole('status').filter({ hasText: 'Ana can no longer create brains.' }),
    ).toBeVisible()
  })

  test('deactivate says what ends and asks first; reactivate brings the person back', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/people')
    const ana = person(page, 'ana@example.test')
    await ana.getByRole('button', { name: 'Deactivate Ana' }).click()
    const dialog = page.getByRole('dialog', { name: 'Deactivate Ana?' })
    await expect(dialog).toContainText('signed out everywhere')
    await expect(dialog).toContainText('What Ana wrote stays')
    await dialog.getByRole('button', { name: 'Deactivate Ana' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Ana is deactivated.' })).toBeFocused()
    await expect(ana).toContainText('deactivated')
    await ana.getByRole('button', { name: 'Reactivate Ana' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Ana is active again.' })).toBeVisible()
    await expect(ana.getByRole('button', { name: 'Deactivate Ana' })).toBeVisible()
  })

  test('a reset link for a person is made here, shown once', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/people')
    const ana = person(page, 'ana@example.test')
    await ana.getByRole('button', { name: 'Make a reset link for Ana' }).click()
    const shown = ana.getByRole('region', { name: /Reset link for Ana/ })
    await expect(shown).toContainText('/reset#token=')
    await shown.getByRole('button', { name: 'Done, I copied it' }).click()
    await expect(page.getByText('/reset#token=')).toHaveCount(0)
  })

  test('someone who is not an administrator is told so, and has no way in', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'member')
    await page.goto('/')
    await page.getByRole('button', { name: /Account/ }).click()
    await expect(page.locator('#account-menu').getByRole('link', { name: 'Administration' })).toHaveCount(0)
    for (const path of ['/admin/people', '/admin/invitations', '/admin/services']) {
      await page.goto(path)
      await expect(page.locator('[data-state="forbidden"]')).toContainText('Only the administration')
    }
  })
})

test.describe('administration: invitations', () => {
  test('by status, with a new link to copy even when it also went by email', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/people')
    await page
      .getByRole('navigation', { name: 'Administration' })
      .getByRole('link', { name: 'Invitations' })
      .click()
    await expect(page).toHaveURL(/\/admin\/invitations$/)
    await expect(page.getByRole('form', { name: 'Invite people' })).toBeVisible()
    const list = page.getByRole('region', { name: 'Invitations' })
    await list.getByLabel('Show').selectOption('expired')
    await expect(list.getByRole('listitem')).toHaveCount(1)
    await expect(list.getByRole('listitem')).toContainText('cy@example.test')
    await list.getByLabel('Show').selectOption('used')
    await expect(list.getByRole('listitem')).toContainText('ana@example.test')
    await list.getByLabel('Show').selectOption('revoked')
    await expect(list.locator('[data-state="filtered-empty"]')).toBeVisible()
    await list.getByRole('button', { name: 'Show all invitations' }).click()
    await expect(list.getByLabel('Show')).toHaveValue('all')
    await list.getByLabel('Show').selectOption('pending')
    const bo = list.getByRole('listitem').filter({ hasText: 'bo@example.test' })
    await bo.getByRole('button', { name: 'New link for bo@example.test' }).click()
    await expect(bo).toContainText('A new link went to bo@example.test.')
    await expect(bo.getByRole('region', { name: 'Invitation for bo@example.test' })).toContainText(
      '/invite#token=',
    )
    await expect(bo.getByRole('button', { name: 'Copy link' })).toBeFocused()
    await bo.getByRole('button', { name: 'Done, I copied it' }).click()
    await expect(page.getByText('/invite#token=')).toHaveCount(0)
    const kept = await page.evaluate(
      () => JSON.stringify({ ...localStorage, ...sessionStorage }) + location.href,
    )
    expect(kept).not.toContain('inv_fixture')
    await audit(page, 'admin invitations')
  })
})

test.describe('administration: service accounts', () => {
  test('each with its brains, main keys and the short keys live, with their references', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/services')
    const svc = page
      .getByRole('region', { name: 'Service accounts' })
      .getByRole('listitem')
      .filter({ hasText: 'Factory runner' })
      .first()
    await expect(svc).toContainText('Growth (contributor)')
    await expect(svc).toContainText('…F4ct')
    await expect(svc).toContainText('3 short keys live: run r_8kq2, step 3, run r_9zz1')
    const old = page
      .getByRole('region', { name: 'Service accounts' })
      .getByRole('listitem')
      .filter({ hasText: 'Old importer' })
      .first()
    await expect(old).toContainText('deactivated')
    await audit(page, 'admin services')
  })

  test('create one: its main key is shown once, and gone once hidden', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/services')
    const form = page.getByRole('form', { name: 'New service account' })
    await form.getByLabel('Name').fill('Nightly import')
    await form.getByRole('checkbox', { name: 'Growth' }).check()
    await form.getByLabel('Role in Growth').selectOption('reader')
    await form.getByRole('button', { name: 'Create service account' }).click()
    const once = page.getByRole('region', { name: 'Main key of Nightly import' })
    await expect(once).toContainText('rscb_')
    await expect(once).toContainText('Shown only now')
    await expect(once.getByRole('button', { name: 'Copy the key' })).toBeFocused()
    const secret = (await once.locator('code').textContent()) ?? ''
    await once.getByRole('button', { name: 'Done, hide the key' }).click()
    await expect(page.getByText(secret)).toHaveCount(0)
    // The keyboard is not lost on the page: it lands on what the hiding says.
    await expect(
      page.getByRole('status').filter({ hasText: 'The key of Nightly import is hidden.' }),
    ).toBeFocused()
    const kept = await page.evaluate(
      () => JSON.stringify({ ...localStorage, ...sessionStorage }) + location.href + document.body.innerHTML,
    )
    expect(kept).not.toContain(secret)
    const row = page
      .getByRole('region', { name: 'Service accounts' })
      .getByRole('listitem')
      .filter({ hasText: 'Nightly import' })
      .first()
    await expect(row).toContainText('Growth (reader)')
    await expect(row).toContainText(`…${secret.slice(-4)}`)
  })

  test('rotate: a new main key once, then the old one revoked after a second press', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/services')
    const svc = page
      .getByRole('region', { name: 'Service accounts' })
      .getByRole('listitem')
      .filter({ hasText: 'Factory runner' })
      .first()
    await svc.getByRole('button', { name: 'New main key for Factory runner' }).click()
    const once = page.getByRole('region', { name: 'Main key of Factory runner' })
    await expect(once).toContainText('rscb_')
    await expect(once).toContainText('then revoke the old one')
    await once.getByRole('button', { name: 'Done, hide the key' }).click()
    // At most two main keys at once: the button says why it waits.
    await expect(svc.getByRole('button', { name: 'New main key for Factory runner' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    const oldKey = svc.getByRole('listitem').filter({ hasText: '…F4ct' })
    await oldKey.getByRole('button', { name: 'Revoke …F4ct' }).click()
    await expect(oldKey.getByRole('button', { name: 'Revoke …F4ct and its short keys' })).toBeFocused()
    await oldKey.getByRole('button', { name: 'Revoke …F4ct and its short keys' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Key …F4ct revoked.' })).toBeFocused()
    await expect(svc.getByRole('listitem').filter({ hasText: '…F4ct' })).toContainText('revoked')
  })

  test('a service account is deactivated in its own words, and the keyboard lands on what happened', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/services')
    const svc = page
      .getByRole('region', { name: 'Service accounts' })
      .getByRole('listitem')
      .filter({ hasText: 'Factory runner' })
      .first()
    await svc.getByRole('button', { name: 'Deactivate Factory runner' }).click()
    const dialog = page.getByRole('dialog', { name: 'Deactivate Factory runner?' })
    await expect(dialog).toContainText('main keys stop working')
    await expect(dialog).not.toContainText('signed out')
    await expect(dialog).not.toContainText('connected apps')
    await dialog.getByRole('button', { name: 'Deactivate Factory runner' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Factory runner is deactivated.' })).toBeFocused()
    await expect(svc).toContainText('deactivated')
    // A new one that was never used says so in its words.
    const form = page.getByRole('form', { name: 'New service account' })
    await form.getByLabel('Name').fill('Fresh runner')
    await form.getByRole('button', { name: 'Create service account' }).click()
    await page
      .getByRole('region', { name: 'Main key of Fresh runner' })
      .getByRole('button', { name: 'Done, hide the key' })
      .click()
    const fresh = page
      .getByRole('region', { name: 'Service accounts' })
      .getByRole('listitem')
      .filter({ hasText: 'Fresh runner' })
      .first()
    await expect(fresh).toContainText('never used')
    await expect(fresh).not.toContainText('signed in')
    // With its only key revoked, it says it has none working.
    await fresh.getByRole('button', { name: /^Revoke …/ }).click()
    await fresh.getByRole('button', { name: /and its short keys$/ }).click()
    await expect(fresh).toContainText('No main key: make one to use this account.')
  })

  test('a key shown is forgotten when the page goes to the back/forward cache', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/admin/services')
    const svc = page
      .getByRole('region', { name: 'Service accounts' })
      .getByRole('listitem')
      .filter({ hasText: 'Factory runner' })
      .first()
    await svc.getByRole('button', { name: 'New main key for Factory runner' }).click()
    await expect(page.getByRole('region', { name: 'Main key of Factory runner' })).toBeVisible()
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
    await expect(page.getByRole('region', { name: 'Main key of Factory runner' })).toHaveCount(0)
  })
})

test.describe('administration: sizes', () => {
  for (const width of [320, 375] as const) {
    test(`at ${width} px nothing scrolls sideways`, async ({ page, context, baseURL }) => {
      await scenario(context, baseURL as string, 'signed-in')
      await page.setViewportSize({ width, height: 800 })
      for (const path of ['/admin/people', '/admin/invitations', '/admin/services']) {
        await page.goto(path)
        await expect(page.getByRole('heading', { level: 1, name: 'Administration' })).toBeVisible()
        await expect(page.getByRole('listitem').first()).toBeVisible()
        await noSideScroll(page)
      }
    })
  }
})
