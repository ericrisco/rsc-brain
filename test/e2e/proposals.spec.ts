// The proposals inbox against the real server and PostgreSQL (plan T026–T028, PR21; local lane): an agent
// proposes; a reader sees the inbox read-only with whom to ask (CA17); a curator at 375 px approves two of
// three independent changes and returns the third with a comment, and the wiki has the two pages, not the
// third, the proposal is `partially_approved` and the comment is a correction in the journal (CA2); another
// proposal returned with a comment at 375 px applies nothing (CA2b); while a curator looks at a proposal,
// another curator approves it and the first sees «approved by … just now» (the live feed). Nothing is
// simulated but the people.
import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from '@playwright/test'
import { keepTheKey } from './key.ts'

const ADMIN = { name: 'Eric', email: 'eric@example.test', password: 'correct horse battery staple' }
const WEB = { 'x-requested-with': 'rsc-brain-web' }
const SLUG = 'inbox-e2e'
const INBOX = `/b/${SLUG}/proposals`

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

// A person invited to the brain with a role, signed in in a context of their own.
async function person(browser: Browser, admin: Page, name: string, role: string): Promise<BrowserContext> {
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
  return ctx
}

let agent = ''
let entry = ''
const ids: Record<string, string> = {}

const create = (address: string) => ({
  op: 'create',
  address,
  type: 'topic',
  title: `Page ${address}`,
  summary: `About ${address}.`,
  body: `What the journal says about ${address}.`,
  sources: [{ entryId: entry }],
  reason: 'One learning.',
})

async function propose(request: APIRequestContext, title: string, ops: unknown[]): Promise<string> {
  const r = await request.post(`/v1/brains/${SLUG}/proposals`, {
    headers: { authorization: `Bearer ${agent}` },
    data: { title, reason: 'The journal of October says so.', agent: 'Claude Code', ops },
  })
  expect(r.status(), await r.text()).toBe(201)
  return ((await r.json()) as { proposal: { id: string } }).proposal.id
}

async function pageStatus(request: APIRequestContext, address: string): Promise<number> {
  return (
    await request.get(`/v1/brains/${SLUG}/pages/${address}`, {
      headers: { authorization: `Bearer ${agent}` },
    })
  ).status()
}

test('an agent proposes; CA17: a reader sees the inbox read-only, with whom to ask', async ({
  page,
  request,
  browser,
  baseURL,
}) => {
  await signedInAdmin(page, baseURL as string)
  expect(
    (
      await page.request.post('/v1/brains', { headers: WEB, data: { slug: SLUG, name: 'Inbox e2e' } })
    ).status(),
  ).toBe(201)
  const t = await page.request.post('/v1/me/tokens', {
    headers: WEB,
    data: { name: 'e2e inbox agent', perm: 'write', brains: [SLUG], days: 30 },
  })
  agent = ((await t.json()) as { token: { secret: string } }).token.secret
  const saved = await request.post(`/v1/brains/${SLUG}/entries`, {
    headers: { authorization: `Bearer ${agent}` },
    data: { type: 'learning', title: 'Short intros keep viewers', content: 'Under ten seconds.' },
  })
  entry = ((await saved.json()) as { receipt: { entryId: string } }).receipt.entryId
  ids.three = await propose(request, 'Three pages about intros', [
    create('intros/short'),
    create('intros/hooks'),
    create('intros/greeting'),
  ])
  ids.back = await propose(request, 'One page too many', [create('intros/extra')])
  ids.live = await propose(request, 'Decided by another curator', [create('intros/live')])

  const rita = await person(browser, page, 'Rita', 'reader')
  const r = await rita.newPage()
  await r.goto(INBOX)
  await expect(r.getByRole('heading', { level: 1, name: 'Proposals' })).toBeVisible()
  await expect(r.getByRole('list', { name: 'Pending proposals' }).getByRole('listitem')).toHaveCount(3)
  await expect(r.getByText('ask a curator of Inbox e2e (Eric) for the curator role')).toBeVisible()
  await r.getByRole('link', { name: 'Three pages about intros' }).click()
  await expect(r.getByRole('article', { name: /^Change 1:/ })).toContainText('New page intros/short')
  await expect(r.getByRole('button', { name: 'Approve all' })).toHaveCount(0)
  await expect(r.getByRole('checkbox')).toHaveCount(0)
  // The server refuses her the same.
  const review = (await (await r.request.get(`/v1/proposals/${ids.three}/review`)).json()) as {
    fingerprint: string
    canDecide: boolean
  }
  expect(review.canDecide).toBe(false)
  const refused = await r.request.post(`/v1/proposals/${ids.three}/approve`, {
    headers: WEB,
    data: { fingerprint: review.fingerprint },
  })
  expect(refused.status()).toBe(403)
  await rita.close()
})

test('CA2: at 375 px a curator approves two of three changes and returns the third with a comment', async ({
  page,
  request,
  baseURL,
}) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await signedInAdmin(page, baseURL as string)
  // The counter of the top bar leads to the inbox.
  await page
    .getByRole('banner')
    .getByRole('link', { name: /3 proposals to review/ })
    .click()
  await expect(page).toHaveURL(new RegExp(`${INBOX}$`))
  await page.getByRole('link', { name: 'Three pages about intros' }).click()
  await page.getByRole('checkbox', { name: 'Approve change 1' }).check()
  await page.getByRole('checkbox', { name: 'Approve change 2' }).check()
  await page.getByLabel('Comment for the agent').fill('No page about greetings: we cut them.')
  await page.getByRole('button', { name: 'Approve selected & return the rest' }).click()
  const done = page.getByRole('status').filter({ hasText: 'Approved in part' })
  await expect(done).toBeVisible()
  await expect(done.getByRole('link', { name: 'intros/short' })).toBeVisible()
  const width = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(width).toBeLessThanOrEqual(375)
  expect(await pageStatus(request, 'intros/short')).toBe(200)
  expect(await pageStatus(request, 'intros/hooks')).toBe(200)
  expect(await pageStatus(request, 'intros/greeting')).toBe(404)
  const p = (await (
    await request.get(`/v1/proposals/${ids.three}`, { headers: { authorization: `Bearer ${agent}` } })
  ).json()) as { proposal: { status: string; comment: string } }
  expect(p.proposal.status).toBe('partially_approved')
  expect(p.proposal.comment).toBe('No page about greetings: we cut them.')
  // The comment is a correction in the journal, for the agent that proposed.
  const corrections = (await (
    await request.get(`/v1/brains/${SLUG}/entries?type=correction`, {
      headers: { authorization: `Bearer ${agent}` },
    })
  ).json()) as { items: Array<{ title: string; content: string; appliesTo: string | null }> }
  const c = corrections.items.find((x) => x.title === 'Returned: Three pages about intros')
  expect(c?.content).toContain('No page about greetings: we cut them.')
  expect(c?.appliesTo).toBe('Claude Code')
})

test('CA2b: at 375 px a curator returns a proposal with a comment; nothing applies', async ({
  page,
  request,
  baseURL,
}) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await signedInAdmin(page, baseURL as string)
  await page.goto(`${INBOX}/${ids.back}`)
  await page.getByLabel('Comment for the agent').fill('One page is enough.')
  await page.getByRole('button', { name: 'Return', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Returned with your comment' })).toBeVisible()
  expect(await pageStatus(request, 'intros/extra')).toBe(404)
  const p = (await (
    await request.get(`/v1/proposals/${ids.back}`, { headers: { authorization: `Bearer ${agent}` } })
  ).json()) as { proposal: { status: string } }
  expect(p.proposal.status).toBe('returned')
})

test('another curator approves it while I look: «approved by … just now», read-only', async ({
  page,
  browser,
  baseURL,
}) => {
  await signedInAdmin(page, baseURL as string)
  const eva = await person(browser, page, 'Eva', 'curator')
  const e = await eva.newPage()
  await e.goto(`${INBOX}/${ids.live}`)
  await expect(e.getByRole('button', { name: 'Approve all' })).toBeVisible()
  // Eva's live feed is open before Eric decides.
  await e.waitForTimeout(500)
  await page.goto(`${INBOX}/${ids.live}`)
  await page.locator('main h1').focus()
  // CA3 on the real server: `a` approves.
  await page.keyboard.press('a')
  await expect(page.getByRole('status').filter({ hasText: 'Approved. These pages changed:' })).toBeVisible()
  await expect(e.getByText('Approved by Eric just now. This proposal is read-only now.')).toBeVisible({
    timeout: 5_000,
  })
  await expect(e.getByRole('button', { name: 'Approve all' })).toHaveCount(0)
  await eva.close()
})
