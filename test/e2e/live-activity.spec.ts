// Activity against the real server and PostgreSQL (plan T037, PR23; local lane). CA6b: Ana's agent searches
// and reads; Bob, a contributor who is not Ana, opens Activity and never sees those searches, while Eric, a
// curator, does. CA8: with Activity open, an agent saves an entry and its line shows in under 2 seconds;
// paused, new lines do not move the list («N new»), and resume puts them on top. Nothing simulated but people.
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test'

const ADMIN = { name: 'Eric', email: 'eric@example.test', password: 'correct horse battery staple' }
const WEB = { 'x-requested-with': 'rsc-brain-web' }
const SLUG = 'activity-e2e'
const A = `/b/${SLUG}/activity`

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
  } else if (where === 'Sign in') {
    await page.getByLabel('Email').fill(ADMIN.email)
    await page.getByLabel('Password').fill(ADMIN.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Your brains' })).toBeVisible()
}

async function person(
  browser: Browser,
  admin: Page,
  name: string,
  role: string,
): Promise<{ ctx: BrowserContext; token: string }> {
  const email = `${name.toLowerCase()}-${Date.now()}@example.test`
  const made = await admin.request.post('/v1/invitations', {
    headers: WEB,
    data: { emails: [email], brains: [{ slug: SLUG, role }] },
  })
  expect(made.status()).toBe(201)
  const link = ((await made.json()) as { invitations: Array<{ link: string }> }).invitations[0]?.link ?? ''
  const ctx = await browser.newContext()
  const accepted = await ctx.request.post('/v1/invitations/accept', {
    headers: WEB,
    data: { token: /#token=([\w-]+)/.exec(link)?.[1] ?? '', name, password: ADMIN.password },
  })
  expect(accepted.status()).toBe(201)
  const t = await ctx.request.post('/v1/me/tokens', {
    headers: WEB,
    data: { name: `${name}'s agent`, perm: 'write', brains: [SLUG], days: 30 },
  })
  return { ctx, token: ((await t.json()) as { token: { secret: string } }).token.secret }
}

let admin: Page
let ana: { ctx: BrowserContext; token: string }
let bob: { ctx: BrowserContext; token: string }

test.beforeAll(async ({ browser, baseURL }) => {
  admin = await (await browser.newContext()).newPage()
  await signedInAdmin(admin, baseURL as string)
  const r = await admin.request.post('/v1/brains', { headers: WEB, data: { slug: SLUG, name: 'Activity' } })
  expect([201, 409]).toContain(r.status())
  ana = await person(browser, admin, 'Ana', 'contributor')
  bob = await person(browser, admin, 'Bob', 'contributor')
})

test.afterAll(async () => {
  await ana.ctx.close()
  await bob.ctx.close()
  await admin.context().close()
})

const feed = (page: Page) => page.getByRole('list', { name: 'Live feed' }).getByRole('listitem')

test("CA6b: a contributor who is not Ana never sees her agent's searches; a curator does", async () => {
  const agent = { authorization: `Bearer ${ana.token}` }
  const searched = await admin.request.get('/v1/search?q=ana-private-plans', { headers: agent })
  expect(searched.status()).toBe(200)
  const saved = await admin.request.post(`/v1/brains/${SLUG}/entries`, {
    headers: agent,
    data: { type: 'note', title: 'Ana writes after searching', content: 'x' },
  })
  expect(saved.status(), await saved.text()).toBe(201)

  const b = await bob.ctx.newPage()
  await b.goto(A)
  await expect(feed(b).filter({ hasText: 'Ana writes after searching' })).toHaveCount(1)
  await expect(feed(b).filter({ hasText: 'ana-private-plans' })).toHaveCount(0)
  // Live too: a search now does not reach Bob, the write after it does.
  await admin.request.get('/v1/search?q=ana-second-look', { headers: agent })
  await admin.request.post(`/v1/brains/${SLUG}/entries`, {
    headers: agent,
    data: { type: 'note', title: 'Ana writes again', content: 'x' },
  })
  await expect(feed(b).filter({ hasText: 'Ana writes again' })).toHaveCount(1)
  await expect(feed(b).filter({ hasText: 'ana-second-look' })).toHaveCount(0)
  await b.close()

  await admin.goto(A)
  await expect(feed(admin).filter({ hasText: 'ana-private-plans' })).toHaveCount(1)
  await expect(feed(admin).filter({ hasText: 'ana-second-look' })).toHaveCount(1)
})

test('CA8: an agent’s write shows in under 2 seconds; pause holds the list until resume', async () => {
  await admin.goto(A)
  await expect(admin.locator('.live-state')).toHaveText('Live')
  const agent = { authorization: `Bearer ${bob.token}` }
  const title = `Live write ${Date.now()}`
  // The clock starts before the write is sent: the 2 s cover the write itself, the feed and the screen.
  const t0 = Date.now()
  const saved = await admin.request.post(`/v1/brains/${SLUG}/entries`, {
    headers: agent,
    data: { type: 'learning', title, content: 'x' },
  })
  expect(saved.status()).toBe(201)
  await expect(feed(admin).first()).toContainText(title, { timeout: 2_000 })
  const shown = Date.now() - t0
  expect(shown, `shown ${shown} ms after the write was sent`).toBeLessThan(2_000)

  await admin.getByRole('button', { name: 'Pause' }).click()
  const before = await feed(admin).count()
  await admin.request.post(`/v1/brains/${SLUG}/entries`, {
    headers: agent,
    data: { type: 'note', title: 'Written while paused', content: 'x' },
  })
  await expect(admin.getByRole('button', { name: 'Resume (1 new)' })).toBeVisible({ timeout: 3_000 })
  await expect(feed(admin)).toHaveCount(before)
  await expect(feed(admin).first()).toContainText(title)
  await admin.getByRole('button', { name: 'Resume (1 new)' }).click()
  await expect(feed(admin).first()).toContainText('Written while paused')
})

test('Health of the new brain says «Nothing to fix»; the open session of an agent shows at the top', async () => {
  const s = await admin.request.post(`/v1/brains/${SLUG}/sessions`, {
    headers: { authorization: `Bearer ${bob.token}` },
    data: { purpose: 'Check the intros', ref: 'ticket 42' },
  })
  expect(s.status(), await s.text()).toBe(201)
  await admin.goto(A)
  const open = admin.getByRole('region', { name: 'Active sessions now' }).getByRole('listitem')
  await expect(open.filter({ hasText: 'Check the intros' })).toContainText('ticket 42')
  // No Factory address is set: the reference is text (CA9 closes in PR25).
  await expect(open.getByRole('link', { name: /ticket 42/ })).toHaveCount(0)
  await admin.goto(`/b/${SLUG}/health`)
  await expect(admin.getByRole('heading', { name: 'Nothing to fix' })).toBeVisible()
})

// Review of PR23: an agent working with a person's token stamps no key reference; its session's reference is
// what a person filters by.
test('the reference filter finds the writes of a session by its reference', async () => {
  const agent = { authorization: `Bearer ${bob.token}` }
  const s = await admin.request.post(`/v1/brains/${SLUG}/sessions`, {
    headers: agent,
    data: { purpose: 'Ticket work', ref: 'ticket-77' },
  })
  expect(s.status(), await s.text()).toBe(201)
  const sid = ((await s.json()) as { session: { id: string } }).session.id
  const saved = await admin.request.post(`/v1/brains/${SLUG}/entries`, {
    headers: agent,
    data: { type: 'note', title: 'Done in ticket 77', content: 'x', sessionId: sid },
  })
  expect(saved.status()).toBe(201)
  await admin.goto(A)
  await expect(feed(admin).filter({ hasText: 'Done in ticket 77' })).toHaveCount(1)
  await admin.locator('summary').filter({ hasText: 'Filter the activity' }).click()
  await admin.getByLabel('Reference').fill('ticket-77')
  await expect(feed(admin).filter({ hasText: 'Done in ticket 77' })).toHaveCount(1)
  await expect(feed(admin).filter({ hasText: 'Live write' })).toHaveCount(0)
})
