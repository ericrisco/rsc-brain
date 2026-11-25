// «Review later» against the real server and PostgreSQL (spec learning-memory A1–A4, B2; plan T010, usage proof):
// an agent's changes apply at once and wait in «Review later», oldest first; a curator undoes part of one, and the
// part that needs it goes too, with a comment that becomes a correction for the agent; undoes another over a page
// written since only when choosing to overwrite; keeps a third, and its page loses the Unreviewed mark; protects a
// page, and the agent's next change to it waits; sets the brain to ask first, and the next change waits whole; sets a
// lifetime. Nothing is simulated but the people. With SHOTS_DIR set, it leaves pictures in light and dark there.
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { keepTheKey } from './key.ts'

const ADMIN = { name: 'Eric', email: 'eric@example.test', password: 'correct horse battery staple' }
const WEB = { 'x-requested-with': 'rsc-brain-web' }
const SLUG = 'review-e2e'
const LIST = `/b/${SLUG}/review-later`
const SHOTS = process.env.SHOTS_DIR ?? ''

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

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await page.screenshot({ path: `${SHOTS}/${name}-${scheme}.png` })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

let agent = ''
let entry = ''
const changes: Record<string, string> = {}

type Receipt = {
  status: string
  undo: string | null
  held: Array<{ op: number; reason: string }>
  proposal: { id: string; status: string }
}
async function propose(request: APIRequestContext, title: string, ops: unknown[]): Promise<Receipt> {
  const r = await request.post(`/v1/brains/${SLUG}/proposals`, {
    headers: { authorization: `Bearer ${agent}` },
    data: { title, reason: 'The journal of October says so.', agent: 'Claude Code', ops },
  })
  expect(r.status(), await r.text()).toBe(201)
  return (await r.json()) as Receipt
}
const create = (address: string, body = `What the journal says about ${address}.`) => ({
  op: 'create',
  address,
  type: 'topic',
  title: `Page ${address}`,
  summary: `About ${address}.`,
  body,
  sources: [{ entryId: entry }],
  reason: 'One learning.',
})

test('an agent writes: each change applies at once and waits in Review later, oldest first', async ({
  page,
  request,
  baseURL,
}) => {
  await signedInAdmin(page, baseURL as string)
  expect(
    (
      await page.request.post('/v1/brains', { headers: WEB, data: { slug: SLUG, name: 'Review e2e' } })
    ).status(),
  ).toBe(201)
  const t = await page.request.post('/v1/me/tokens', {
    headers: WEB,
    data: { name: 'e2e review agent', perm: 'write', brains: [SLUG], days: 30 },
  })
  agent = ((await t.json()) as { token: { secret: string } }).token.secret
  const saved = await request.post(`/v1/brains/${SLUG}/entries`, {
    headers: { authorization: `Bearer ${agent}` },
    data: { type: 'learning', title: 'Short intros keep viewers', content: 'Under ten seconds.' },
  })
  entry = ((await saved.json()) as { receipt: { entryId: string } }).receipt.entryId
  const one = await propose(request, 'Retention basics', [create('retention/basics')])
  expect([one.status, one.proposal.status]).toEqual(['applied', 'applied'])
  changes.basics = one.undo as string
  // The second change creates a page and links the first to it: the link needs the page.
  const two = await propose(request, 'Short intros, linked from retention', [
    create('intros/short'),
    {
      op: 'link',
      address: 'retention/basics',
      to: 'intros/short',
      kind: 'related',
      reason: 'They go together.',
    },
  ])
  expect(two.status).toBe('applied')
  changes.intros = two.undo as string
  const three = await propose(request, 'Hooks', [create('intros/hooks')])
  changes.hooks = three.undo as string
  expect(Object.values(changes).every((c) => /^chg_/.test(c))).toBe(true)

  await page.goto(LIST)
  await expect(page.getByRole('heading', { level: 1, name: 'Review later' })).toBeVisible()
  const rows = page.locator('[data-review-list] > li')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText('Retention basics')
  await expect(rows.nth(0)).toContainText('e2e review agent')
  await expect(rows.nth(2)).toContainText('Hooks')
  await expect(
    page
      .getByRole('navigation', { name: 'Sections of this brain' })
      .getByRole('link', { name: /^Review later/ }),
  ).toContainText('3')
  await page.goto(`/b/${SLUG}/pages/intros/short`)
  await expect(page.locator('[data-mark="unreviewed"]')).toBeVisible()
  await page.goto(LIST)
  await expect(rows).toHaveCount(3)
  await shot(page, 'review-later-list')
})

test('undo by parts: the part that needs the undone one goes with it; the comment becomes a correction', async ({
  page,
  request,
  baseURL,
}) => {
  await signedInAdmin(page, baseURL as string)
  await page.goto(`${LIST}/${changes.intros}`)
  await expect(page.locator('[data-part]')).toHaveCount(2)
  await page.getByRole('button', { name: 'Undo…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Undo this change' })
  await dialog.getByLabel('Only some parts').check()
  await dialog.getByLabel('Part 1: intros/short').check()
  const needer = dialog.getByLabel('Part 2: retention/basics')
  await expect(needer).toBeChecked()
  await expect(needer).toBeDisabled()
  await dialog.getByLabel('Comment (optional)').fill('Intros live under guides, not as a topic.')
  await shot(page, 'review-later-undo-parts')
  const answer = page.waitForResponse((r) => r.url().endsWith(`/v1/wiki/changes/${changes.intros}/undo`))
  await dialog.getByRole('button', { name: 'Undo', exact: true }).click()
  const undone = (await (await answer).json()) as { correction?: string }
  await expect(page.getByText('Undone: 2 pages back as they were.')).toBeVisible()
  const detail = await (await page.request.get(`/v1/wiki/changes/${changes.intros}`)).json()
  expect(detail.change.state).toBe('undone')
  const short = await request.get(`/v1/brains/${SLUG}/pages/intros/short`, {
    headers: { authorization: `Bearer ${agent}` },
  })
  // The page it created is retired and its address freed (M7): nobody finds it there any more.
  expect(short.status()).toBe(404)
  // The comment is a correction the agent meets in the journal.
  expect(undone.correction).toBeTruthy()
  const correction = await page.request.get(`/v1/entries/${undone.correction}`)
  expect(correction.status()).toBe(200)
  expect(JSON.stringify(await correction.json())).toContain('Intros live under guides')
})

test('undo over a page written since: a conflict, then undone when the curator chooses to overwrite', async ({
  page,
  baseURL,
}) => {
  await signedInAdmin(page, baseURL as string)
  await page.goto(`${LIST}/${changes.basics}`)
  await page.getByRole('button', { name: 'Undo…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Undo this change' })
  await dialog.getByRole('button', { name: 'Undo', exact: true }).click()
  const alert = dialog.locator('[data-state="undo-conflict"]')
  await expect(alert).toContainText('Some pages changed after this change')
  await shot(page, 'review-later-conflict')
  await dialog.getByLabel('Undo over the later changes of retention/basics').check()
  await dialog.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.getByText('Undone: 1 page back as they were.')).toBeVisible()
})

test('Keep, the Protected switch and the mode: a protected page and an ask-first brain make the agent wait', async ({
  page,
  request,
  baseURL,
}) => {
  await signedInAdmin(page, baseURL as string)
  await page.goto(`/b/${SLUG}/pages/intros/hooks`)
  await expect(page.locator('[data-mark="unreviewed"]')).toBeVisible()
  const sw = page.getByRole('switch', { name: 'Protected' })
  await expect(sw).toHaveAttribute('aria-checked', 'false')
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('[data-mark="protected"]')).toBeVisible()
  await shot(page, 'page-protected-unreviewed')
  const read = await request.get(`/v1/brains/${SLUG}/pages/intros/hooks`, {
    headers: { authorization: `Bearer ${agent}` },
  })
  const revision = ((await read.json()) as { page: { revision: number } }).page.revision
  const held = await propose(request, 'Hooks, sharper', [
    { op: 'edit', address: 'intros/hooks', baseRevision: revision, body: 'Sharper.', reason: 'Tighter.' },
  ])
  expect([held.status, held.held[0]?.reason]).toEqual(['held', 'protected'])
  // Keep: the change leaves the tray, the page its mark.
  await page.goto(`${LIST}/${changes.hooks}`)
  await page.getByRole('button', { name: 'Keep', exact: true }).click()
  await expect(page.getByText('Kept. Its pages count as reviewed.')).toBeVisible()
  await page.goto(`/b/${SLUG}/pages/intros/hooks`)
  await expect(page.getByRole('switch', { name: 'Protected' })).toBeVisible()
  await expect(page.locator('[data-mark="unreviewed"]')).toHaveCount(0)
  await page.goto(LIST)
  await expect(page.locator('[data-review-list] > li')).toHaveCount(0)
  // Ask first, and a lifetime by type.
  await page.goto(`/b/${SLUG}/settings/memory`)
  const mode = page.getByRole('region', { name: 'When agents change the wiki' })
  await mode.getByLabel('Ask first').check()
  await mode.getByRole('button', { name: 'Save' }).click()
  await expect(mode.locator('#write-mode-said')).not.toBeEmpty()
  const life = page.getByRole('region', { name: 'How long entries last without use' })
  await life.getByLabel('Days for notes').fill('45')
  await life.getByRole('button', { name: 'Save' }).click()
  await expect(life.locator('#lifetimes-said')).not.toBeEmpty()
  const settings = (await (await page.request.get(`/v1/brains/${SLUG}/wiki/settings`)).json()) as {
    writeMode: string
    entryLifetimes: Record<string, number | null>
  }
  expect([settings.writeMode, settings.entryLifetimes.note]).toEqual(['ask_first', 45])
  const waits = await propose(request, 'Greeting', [create('intros/greeting')])
  expect([waits.status, waits.undo, waits.held[0]?.reason]).toEqual(['held', null, 'ask_first'])
})
