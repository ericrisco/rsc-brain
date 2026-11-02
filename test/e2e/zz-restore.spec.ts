// Admin › Backups & system against the real server and PostgreSQL (plan T018; CA10 web, risk 9; local lane): a copy
// made by hand; a copy that fails shows the band at the top of the administration until a good copy; restoring a copy
// with the name of the installation and the password answers first, then everyone (this person too) signs in again,
// with «Restored. Everyone signs in again». Files run in name order on one server: this one runs last, because a
// restore ends every session and key of the installation.
import { chmod } from 'node:fs/promises'
import { expect, type Page, test } from '@playwright/test'
import { keepTheKey } from './key.ts'

const ADMIN = { name: 'Eric', email: 'eric@example.test', password: 'correct horse battery staple' }

test.describe.configure({ mode: 'serial' })

async function signedInAdmin(page: Page, baseURL: string): Promise<void> {
  await page.goto('/')
  const h1 = page.getByRole('heading', { level: 1 })
  await expect(h1).toHaveText(/Set up rsc-brain|Sign in|Your brains/)
  const where = await h1.textContent()
  if (where === 'Set up rsc-brain') {
    await page.getByLabel('Name of this installation').fill('rsc-brain')
    await page.getByLabel('Address people open').fill(baseURL)
    await page.getByLabel('Your name').fill(ADMIN.name)
    await page.getByLabel('Your email').fill(ADMIN.email)
    await page.getByLabel('Password', { exact: true }).fill(ADMIN.password)
    await page.getByRole('button', { name: 'Set up and sign in' }).click()
    await keepTheKey(page)
  } else if (where === 'Sign in') {
    await page.getByLabel('Email').fill(ADMIN.email)
    await page.getByLabel('Password').fill(ADMIN.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Your brains' })).toBeVisible()
}

async function makeCopy(page: Page, done: RegExp): Promise<void> {
  await page.goto('/admin/system')
  const part = page.getByRole('region', { name: 'Backups' })
  await expect(part.getByRole('button', { name: 'Make a copy now' })).toBeVisible()
  await part.getByRole('button', { name: 'Make a copy now' }).click()
  await expect(part.getByRole('status').filter({ hasText: done })).toBeFocused({ timeout: 20_000 })
}

test('CA10 (web): a copy that fails shows the band of the administration until a good copy', async ({
  page,
  baseURL,
}) => {
  await signedInAdmin(page, baseURL as string)
  const { dir } = (await (await page.request.get('/__e2e/backups')).json()) as { dir: string }
  await makeCopy(page, /Copy made:/)
  await chmod(dir, 0o500)
  try {
    await makeCopy(page, /The copy did not finish/)
    await expect(page.getByRole('note').filter({ hasText: 'The last copy failed' })).toContainText(
      'rsc-brain cannot write in the folder of the copies',
    )
    await page.goto('/admin/people')
    await expect(page.getByRole('alert').filter({ hasText: 'The last copy failed' })).toBeVisible()
  } finally {
    await chmod(dir, 0o700)
  }
  await makeCopy(page, /Copy made:/)
  await page.goto('/admin/people')
  await expect(page.getByRole('heading', { level: 1, name: 'Administration' })).toBeVisible()
  await expect(page.getByText('The last copy failed')).toHaveCount(0)
})

test('risk 9: restoring with the name and the password answers first; then everyone signs in again', async ({
  page,
  browser,
  baseURL,
}) => {
  await signedInAdmin(page, baseURL as string)
  const name = ((await (await page.request.get('/v1/me')).json()) as { installation: { name: string } })
    .installation.name
  // Another person's session elsewhere ends too.
  const other = await browser.newContext()
  const otherPage = await other.newPage()
  await signedInAdmin(otherPage, baseURL as string)
  await makeCopy(page, /Copy made:/)
  const part = page.getByRole('region', { name: 'Backups' })
  await part
    .locator('.copies > li')
    .first()
    .getByRole('button', { name: /Restore the copy of/ })
    .click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('First, rsc-brain makes a copy of what is here now')
  await dialog.getByLabel('Name of this installation').fill(name)
  await dialog.getByLabel('Your password').fill(ADMIN.password)
  await dialog.getByRole('button', { name: 'Restore this copy' }).click()
  await expect(page).toHaveURL(/\/sign-in$/, { timeout: 30_000 })
  await expect(
    page.getByRole('status').filter({ hasText: 'Restored. Everyone signs in again' }),
  ).toBeVisible()
  expect((await page.request.get('/v1/me')).status()).toBe(401)
  expect((await otherPage.request.get('/v1/me')).status()).toBe(401)
  await other.close()
  // Signing in again works, and the copy made before the restore is listed.
  await page.getByLabel('Email').fill(ADMIN.email)
  await page.getByLabel('Password').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Your brains' })).toBeVisible()
  await page.goto('/admin/system')
  await expect(page.getByRole('region', { name: 'Backups' })).toContainText('Before a restore')
})
