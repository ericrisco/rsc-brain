// Without mail, nothing promises an email (review of PR18, P4): home's «Get started», the invite panel
// and the invite page say that the inviter gets a link to send; with mail they still say email.
import type { Page } from '@playwright/test'
import { expect, scenario, test } from './fixture.ts'

async function firstBrain(page: Page) {
  await page.getByRole('button', { name: 'Create brain' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Create a brain' })
  await dialog.getByLabel('Name').fill('Onboarding')
  await dialog.getByRole('button', { name: 'Create brain' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Onboarding' })).toBeVisible()
  await page.goto('/')
}

for (const mail of [true, false]) {
  test.describe(`mail ${mail ? 'on' : 'off'}`, () => {
    const says = mail ? /email/ : /a link .*to send/
    const never = mail ? /a link .*to send/ : /email/

    test('home: «Get started» step 2 and the invite panel', async ({ page, context, baseURL }) => {
      await scenario(context, baseURL as string, 'alone', {}, { mail })
      await page.goto('/')
      const start = page.getByRole('region', { name: 'Get started' })
      const step = start
        .getByRole('listitem')
        .filter({ has: page.getByRole('link', { name: 'Invite people' }) })
      await expect(step).toContainText(says)
      await expect(step).not.toContainText(never)
      await firstBrain(page)
      const panel = page.getByRole('region', { name: 'Invite people' })
      await expect(panel).toContainText(says)
      await expect(panel).not.toContainText(never)
    })

    test('the invite page without a token', async ({ page, context, baseURL }) => {
      await scenario(context, baseURL as string, 'signed-out', {}, { mail })
      await page.goto('/invite')
      const problem = page.getByRole('main')
      await expect(problem).toContainText('This address has no invitation in it')
      if (mail) await expect(problem).toContainText('email')
      else await expect(problem).not.toContainText('email')
    })
  })
}
