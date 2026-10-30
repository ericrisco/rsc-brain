// The doors of the web against the real server and PostgreSQL (plan T009, local lane): first run from the
// web, an invitation sent by email and accepted, signing out and in, and a password reset. One fresh
// installation for the whole file, in order.
import { type APIRequestContext, expect, test } from '@playwright/test'

const ADMIN = { name: 'Eric', email: 'eric@example.test', password: 'correct horse battery staple' }
const WEB = { 'x-requested-with': 'rsc-brain-web' }

test.describe.configure({ mode: 'serial' })

async function mailLink(request: APIRequestContext, to: string, kind: 'invite' | 'reset'): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const r = await request.get(`/__e2e/mail?to=${encodeURIComponent(to)}`)
    if (r.ok()) {
      const m = (await r.json()) as { text: string }
      const link = new RegExp(`https?://\\S+/${kind}#token=[\\w-]+`).exec(m.text)?.[0]
      if (link) return new URL(link).pathname + new URL(link).hash
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`no ${kind} mail to ${to}`)
}

test('first run from the web makes the administrator and signs them in', async ({ page, baseURL }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/setup$/)
  await page.getByLabel('Name of this installation').fill('rsc-brain')
  await page.getByLabel('Address people open').fill(baseURL as string)
  await page.getByLabel('Your name').fill(ADMIN.name)
  await page.getByLabel('Your email').fill(ADMIN.email)
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password)
  await page.getByRole('button', { name: 'Set up and sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Your brains' })).toBeVisible()
  // U1: the administrator sees it worked and the next step, with the agent command for this address.
  await expect(page.getByRole('status').filter({ hasText: 'Brain is set up.' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible()
  await expect(page.getByText(`${baseURL}/mcp`)).toBeVisible()
  await expect(page.locator('header')).toContainText('rsc-brain')
})

test('an invitation by email is accepted and opens a session', async ({ page, browser }) => {
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill(ADMIN.email)
  await page.getByLabel('Password').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Your brains' })).toBeVisible()
  // The admin creates a brain and invites Marta with the same session the web uses.
  const made = await page.request.post('/v1/brains', {
    headers: WEB,
    data: { slug: 'growth', name: 'Growth', purpose: 'Audience and retention.' },
  })
  expect(made.status()).toBe(201)
  const inv = await page.request.post('/v1/invitations', {
    headers: WEB,
    data: { emails: ['marta@example.test'], brains: [{ slug: 'growth', role: 'contributor' }] },
  })
  expect(inv.status()).toBe(201)
  const link = await mailLink(page.request, 'marta@example.test', 'invite')

  const marta = await browser.newContext()
  const p = await marta.newPage()
  await p.goto(link)
  await expect(p.getByRole('heading', { name: 'Accept your invitation' })).toBeVisible()
  await expect(p).toHaveURL(/\/invite$/)
  await expect(p.getByText('marta@example.test')).toBeVisible()
  await expect(p.getByText('Growth')).toBeVisible()
  await p.getByLabel('Your name').fill('Marta')
  await p.getByLabel('Choose a password').fill('a long passphrase for marta')
  await p.getByRole('button', { name: 'Create my account' }).click()
  await expect(p.getByRole('link', { name: 'Growth' })).toBeVisible()
  // The welcome comes from the real accept answer: what she joined, with her role.
  await expect(p.getByRole('status').filter({ hasText: /Welcome — you joined Growth as/ })).toBeVisible()
  const me = await p.request.get('/v1/me')
  expect(((await me.json()) as { account: { name: string } }).account.name).toBe('Marta')
  // The link works once; opened again while signed in, it says so and leads to her brains.
  await p.goto(link)
  await expect(p.getByRole('heading', { level: 1, name: 'This invitation is already used' })).toBeVisible()
  await expect(p.getByRole('alert')).toContainText('This invitation link is not valid')
  await expect(p.getByRole('main').getByRole('link', { name: 'Go to your brains' })).toBeVisible()
  await marta.close()
})

test('signing out ends the session; signing in again works', async ({ page }) => {
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill('marta@example.test')
  await page.getByLabel('Password').fill('a long passphrase for marta')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('link', { name: 'Growth' }).click()
  await expect(page.getByRole('heading', { name: 'Growth' })).toBeVisible()
  await page.getByRole('button', { name: /Account/ }).click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/sign-in$/)
  await expect(page.getByRole('status').filter({ hasText: 'Signed out.' })).toBeVisible()
  expect((await page.request.get('/v1/me')).status()).toBe(401)
})

test('a password reset by email sets a new password', async ({ page, browser }) => {
  await page.goto('/reset')
  await page.getByLabel('Email').fill('marta@example.test')
  await page.getByRole('button', { name: 'Send the link' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  const link = await mailLink(page.request, 'marta@example.test', 'reset')
  const ctx = await browser.newContext()
  const p = await ctx.newPage()
  await p.goto(link)
  await p.getByLabel('New password').fill('a newer passphrase for marta')
  await p.getByRole('button', { name: 'Save the new password' }).click()
  await expect(p.getByRole('heading', { name: 'Your password is changed' })).toBeVisible()
  await p.getByRole('link', { name: 'Sign in' }).click()
  await p.getByLabel('Email').fill('marta@example.test')
  await p.getByLabel('Password').fill('a newer passphrase for marta')
  await p.getByRole('button', { name: 'Sign in' }).click()
  await expect(p.getByRole('link', { name: 'Growth' })).toBeVisible()
  await ctx.close()
})
