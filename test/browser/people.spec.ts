// Inviting people from the web (spec B4 «Invitar», B6 «Admin › people · invitations»; moved to PR18 by the
// usability review of PR17): whoever may invite gives emails, brains and a role; with mail the invitation
// goes by email, without it the single-use link is shown once to copy; pending invitations can get a new
// link or be withdrawn; and the administration makes a reset link for a person.
import { expect, noSideScroll, scenario, test } from './fixture.ts'

test.describe('invite', () => {
  test('the administration invites two people to a brain by email; they wait in the list', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/')
    await page.getByRole('button', { name: /Account/ }).click()
    await page.getByRole('link', { name: 'People' }).click()
    await expect(page).toHaveURL(/\/people$/)
    await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible()
    const form = page.getByRole('form', { name: 'Invite people' })
    await form.getByLabel('Emails').fill('zoe@example.test, yan@example.test')
    await form.getByRole('checkbox', { name: 'Growth' }).check()
    await form.getByLabel('Role in Growth').selectOption('contributor')
    await form.getByRole('button', { name: 'Send invitations' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Invitations sent' })).toContainText(
      'zoe@example.test',
    )
    // The link went by mail: it is not shown.
    await expect(page.getByText('/invite#token=')).toHaveCount(0)
    const list = page.getByRole('region', { name: 'Invitations' })
    await expect(list.getByRole('listitem').filter({ hasText: 'zoe@example.test' })).toContainText('pending')
    await expect(list.getByRole('listitem').filter({ hasText: 'zoe@example.test' })).toContainText(
      'Growth as contributor',
    )
  })

  test('without mail, the link is shown once to copy, and gone once closed', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { mail: false })
    await page.goto('/people')
    const form = page.getByRole('form', { name: 'Invite people' })
    await expect(form).toContainText('This installation cannot send email')
    await form.getByLabel('Emails').fill('zoe@example.test')
    await form.getByRole('button', { name: 'Create invitation link' }).click()
    const shown = page.getByRole('region', { name: 'Links to send' })
    await expect(shown).toContainText('zoe@example.test')
    await expect(shown).toContainText('/invite#token=')
    await expect(shown).toContainText('Shown only now')
    await expect(shown.getByRole('button', { name: 'Copy link' })).toBeVisible()
    await shown.getByRole('button', { name: 'Done, I copied it' }).click()
    await expect(page.getByText('/invite#token=')).toHaveCount(0)
    const kept = await page.evaluate(
      () => JSON.stringify({ ...localStorage, ...sessionStorage }) + location.href,
    )
    expect(kept).not.toContain('inv_fixture')
  })

  test('a wrong email is said next to the field; nothing is sent and the text stays', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/people')
    const form = page.getByRole('form', { name: 'Invite people' })
    await form.getByLabel('Emails').fill('zoe@example.test, not-an-email')
    await form.getByRole('button', { name: 'Send invitations' }).click()
    await expect(form.getByText('"not-an-email" is not an email')).toBeVisible()
    await expect(form.getByLabel('Emails')).toBeFocused()
    await expect(form.getByLabel('Emails')).toHaveValue('zoe@example.test, not-an-email')
  })

  test('someone who already has an account: the server says what to do instead', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/people')
    const form = page.getByRole('form', { name: 'Invite people' })
    await form.getByLabel('Emails').fill('ana@example.test')
    await form.getByRole('button', { name: 'Send invitations' }).click()
    await expect(form.getByRole('alert')).toContainText('ana@example.test already has an account.')
    await expect(form.getByRole('alert')).toContainText('Add that person to the brain as a member instead.')
    await expect(form.getByLabel('Emails')).toHaveValue('ana@example.test')
  })
})

test.describe('pending invitations', () => {
  test('a new link, shown once without mail; withdrawing one says so', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { mail: false })
    await page.goto('/people')
    const bo = page.getByRole('region', { name: 'Invitations' }).getByRole('listitem').filter({
      hasText: 'bo@example.test',
    })
    await bo.getByRole('button', { name: 'New link' }).click()
    await expect(page.getByRole('region', { name: 'Links to send' })).toContainText('bo@example.test')
    await bo.getByRole('button', { name: 'Withdraw' }).click()
    const confirm = page.getByRole('dialog', { name: 'Withdraw the invitation?' })
    await expect(confirm).toContainText('bo@example.test')
    await confirm.getByRole('button', { name: 'Withdraw invitation' }).click()
    await expect(bo).toContainText('withdrawn')
    await expect(bo.getByRole('button', { name: 'Withdraw' })).toHaveCount(0)
  })
})

test.describe('reset links', () => {
  test('the administration makes a reset link for a person, shown once to copy', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/people')
    const ana = page
      .getByRole('region', { name: 'People in this installation' })
      .getByRole('listitem')
      .filter({
        hasText: 'ana@example.test',
      })
    await ana.getByRole('button', { name: 'Make a reset link' }).click()
    const shown = page.getByRole('region', { name: 'Links to send' })
    await expect(shown).toContainText('Ana')
    await expect(shown).toContainText('/reset#token=')
    await expect(shown).toContainText('works once, for 1 hour')
    await shown.getByRole('button', { name: 'Done, I copied it' }).click()
    await expect(page.getByText('/reset#token=')).toHaveCount(0)
  })
})

test.describe('who may', () => {
  test('a person who may not invite is told who can, and is not offered the page', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'member')
    await page.goto('/')
    await page.getByRole('button', { name: /Account/ }).click()
    await expect(page.getByRole('link', { name: 'People' })).toHaveCount(0)
    await page.goto('/people')
    await expect(page.getByRole('alert')).toContainText('Only the administration invites new people')
    await expect(page.getByRole('alert')).toContainText('Ask the administration')
  })

  test('at 320 px the page fits', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in', {}, { mail: false })
    await page.setViewportSize({ width: 320, height: 640 })
    await page.goto('/people')
    await page.getByLabel('Emails').fill('zoe@example.test')
    await page.getByRole('button', { name: 'Create invitation link' }).click()
    await expect(page.getByRole('region', { name: 'Links to send' })).toBeVisible()
    await noSideScroll(page)
  })
})
