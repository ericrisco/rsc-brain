// A brain's settings and the administration against the real server and PostgreSQL (plan T046–T047,
// PR25a; local lane): the last curator of a brain and the last administrator of the installation stay,
// on the screen and on the server; a service account's main key is shown once and never again; and an
// archived brain refuses an agent's write until it is unarchived.
import { expect, type Page, test } from '@playwright/test'

const ADMIN = { name: 'Eric', email: 'eric@example.test', password: 'correct horse battery staple' }
const WEB = { 'x-requested-with': 'rsc-brain-web' }

test.describe.configure({ mode: 'serial' })

// The installation of this run: set up from the web if no file did it yet, then signed in.
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
  } else if (where === 'Sign in') {
    await page.getByLabel('Email').fill(ADMIN.email)
    await page.getByLabel('Password').fill(ADMIN.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Your brains' })).toBeVisible()
}

async function newBrain(page: Page, name: string): Promise<string> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create brain' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Create a brain' })
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByLabel('What it is for').fill('What the settings e2e walks.')
  await dialog.getByRole('button', { name: 'Create brain' }).click()
  await expect(page).toHaveURL(/\/b\/[^/]+$/)
  return decodeURIComponent(new URL(page.url()).pathname.split('/')[2] as string)
}

const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true })

test('the last curator of a brain stays: the screen says why, and the server refuses', async ({
  page,
  baseURL,
}) => {
  await signedInAdmin(page, baseURL as string)
  const slug = await newBrain(page, 'Settings last curator')
  const me = ((await (await page.request.get('/v1/me')).json()) as { account: { id: string } }).account.id
  await page.goto(`/b/${slug}/settings`)
  const eric = region(page, 'Members').getByRole('listitem').filter({ hasText: 'Eric' })
  await expect(eric).toContainText('Only curator')
  await expect(eric.getByRole('combobox')).toBeDisabled()
  // What the screen does not offer, the server still refuses (the web only hides).
  const demote = await page.request.put(`/v1/brains/${slug}/members/${me}`, {
    headers: WEB,
    data: { role: 'reader' },
  })
  expect([demote.status(), ((await demote.json()) as { error: { code: string } }).error.code]).toEqual([
    409,
    'last_curator',
  ])
  const leave = await page.request.delete(`/v1/brains/${slug}/members/${me}`, { headers: WEB })
  expect(leave.status()).toBe(409)
  await page.reload()
  await expect(region(page, 'Members').getByRole('listitem').filter({ hasText: 'Eric' })).toContainText(
    'curator',
  )
})

test('the last administrator stays: the screen says why, and the server refuses', async ({
  page,
  baseURL,
}) => {
  await signedInAdmin(page, baseURL as string)
  const accounts = (await (await page.request.get('/v1/admin/accounts')).json()) as {
    accounts: Array<{ id: string; kind: string; isAdmin: boolean; status: string; email: string | null }>
  }
  const admins = accounts.accounts.filter((a) => a.kind === 'person' && a.isAdmin && a.status === 'active')
  test.skip(admins.length !== 1, 'another e2e file made a second administrator')
  const me = admins[0]?.id as string
  await page.goto('/admin/people')
  const eric = region(page, 'People in this installation')
    .getByRole('listitem')
    .filter({ hasText: ADMIN.email })
  await expect(eric).toContainText('Only administrator')
  await expect(eric.getByRole('button', { name: 'Remove administrator rights from Eric' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  const step = await page.request.patch(`/v1/admin/accounts/${me}`, {
    headers: WEB,
    data: { isAdmin: false },
  })
  expect([step.status(), ((await step.json()) as { error: { code: string } }).error.code]).toEqual([
    409,
    'last_admin',
  ])
})

test('a service account: its main key is shown once, then never again', async ({ page, baseURL }) => {
  await signedInAdmin(page, baseURL as string)
  const slug = await newBrain(page, 'Settings service')
  await page.goto('/admin/services')
  const form = page.getByRole('form', { name: 'New service account' })
  await form.getByLabel('Name').fill('E2E runner')
  await form.getByRole('checkbox', { name: 'Settings service' }).check()
  await form.getByRole('button', { name: 'Create service account' }).click()
  const once = page.getByRole('region', { name: 'Main key of E2E runner' })
  const secret = ((await once.locator('code').textContent()) ?? '').trim()
  expect(secret).toMatch(/^rscb_/)
  // The key works for what it was given: the brain chosen, as a contributor.
  const saved = await page.request.post(`/v1/brains/${slug}/entries`, {
    headers: { authorization: `Bearer ${secret}` },
    data: { type: 'note', title: 'From the runner', content: 'The service account writes.' },
  })
  expect(saved.status()).toBe(201)
  await once.getByRole('button', { name: 'Done, hide the key' }).click()
  await expect(page.getByText(secret)).toHaveCount(0)
  await page.reload()
  const row = region(page, 'Service accounts').getByRole('listitem').filter({ hasText: 'E2E runner' }).first()
  await expect(row).toContainText(`…${secret.slice(-4)}`)
  expect(await page.content()).not.toContain(secret)
  const kept = await page.evaluate(
    () => JSON.stringify({ ...localStorage, ...sessionStorage }) + location.href,
  )
  expect(kept).not.toContain(secret)
  // Nothing the administration reads gives it back.
  const accounts = await (await page.request.get('/v1/admin/accounts')).text()
  expect(accounts).not.toContain(secret)
  const id = (JSON.parse(accounts) as { accounts: Array<{ id: string; name: string }> }).accounts.find(
    (a) => a.name === 'E2E runner',
  )?.id
  expect(await (await page.request.get(`/v1/admin/accounts/${id}/keys`)).text()).not.toContain(secret)
})

test('archiving: the brain refuses an agent write until it is unarchived', async ({
  page,
  request,
  baseURL,
}) => {
  await signedInAdmin(page, baseURL as string)
  const slug = await newBrain(page, 'Settings archive')
  const made = await page.request.post('/v1/me/tokens', {
    headers: WEB,
    data: { name: 'e2e archive agent', perm: 'write', brains: [slug], days: 30 },
  })
  const secret = ((await made.json()) as { token: { secret: string } }).token.secret
  const write = (title: string) =>
    request.post(`/v1/brains/${slug}/entries`, {
      headers: { authorization: `Bearer ${secret}` },
      data: { type: 'note', title, content: `${title}.` },
    })
  await page.goto(`/b/${slug}/settings`)
  await region(page, 'Archive').getByRole('button', { name: 'Archive this brain' }).click()
  const dialog = page.getByRole('dialog', { name: 'Archive Settings archive?' })
  await expect(dialog).toContainText('No one can write to it')
  await dialog.getByRole('button', { name: 'Archive Settings archive' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Settings archive is archived.' })).toBeVisible()
  const refused = await write('While archived')
  expect(refused.status()).toBe(403)
  expect(await refused.text()).toContain('archived')
  await region(page, 'Archive').getByRole('button', { name: 'Unarchive this brain' }).click()
  await expect(
    page.getByRole('status').filter({ hasText: 'Settings archive is active again.' }),
  ).toBeVisible()
  expect((await write('After unarchiving')).status()).toBe(201)
})
