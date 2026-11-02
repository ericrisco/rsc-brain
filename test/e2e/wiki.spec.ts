// The wiki against the real server and PostgreSQL (plan T017–T019, PR19; local lane): a page with two
// sources that open beside it (CA4), its history compared from revision 1 to 3 and restored, «who read
// this» for curators only, and two curators editing the same page — the second sees the new version and
// keeps their text (CA10). Nothing here is simulated but the people.
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
const SLUG = 'wiki-e2e'
const PAGE = `/b/${SLUG}/pages/audience/retention`

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

// A person invited to the brain with a role, signed in in a context of their own (through v1, as the
// web does it: the invitation's link, accepted with a password).
async function person(browser: Browser, admin: Page, name: string, role: string): Promise<BrowserContext> {
  const email = `${name.toLowerCase()}-${Date.now()}@example.test`
  const made = await admin.request.post('/v1/invitations', {
    headers: WEB,
    data: { emails: [email], brains: [{ slug: SLUG, role }] },
  })
  expect(made.status()).toBe(201)
  const link = ((await made.json()) as { invitations: Array<{ link: string }> }).invitations[0]?.link ?? ''
  const token = /#token=([\w-]+)/.exec(link)?.[1] ?? ''
  const ctx = await browser.newContext()
  const accepted = await ctx.request.post('/v1/invitations/accept', {
    headers: WEB,
    data: { token, name, password: ADMIN.password },
  })
  expect(accepted.status()).toBe(201)
  return ctx
}

async function seed(page: Page, request: APIRequestContext): Promise<void> {
  expect(
    (
      await page.request.post('/v1/brains', { headers: WEB, data: { slug: SLUG, name: 'Wiki e2e' } })
    ).status(),
  ).toBe(201)
  const made = await page.request.post('/v1/me/tokens', {
    headers: WEB,
    data: { name: 'e2e agent', perm: 'write', brains: [SLUG], days: 30 },
  })
  const secret = ((await made.json()) as { token: { secret: string } }).token.secret
  const save = async (title: string, content: string) => {
    const r = await request.post(`/v1/brains/${SLUG}/entries`, {
      headers: { authorization: `Bearer ${secret}` },
      data: { type: 'learning', title, content },
    })
    expect(r.status()).toBe(201)
    return ((await r.json()) as { receipt: { entryId: string } }).receipt.entryId
  }
  const a = await save('Short intros keep viewers', 'Intros under ten seconds kept 70% of viewers.')
  const b = await save('The hook goes first', 'Start with the question of the video.')
  const change = async (op: Record<string, unknown>) => {
    const r = await page.request.post(`/v1/brains/${SLUG}/wiki/changes`, {
      headers: WEB,
      data: { reason: 'Seed.', ...op },
    })
    expect(r.status(), await r.text()).toBe(201)
  }
  await change({
    op: 'create',
    address: 'audience/intros',
    type: 'guide',
    title: 'Writing intros',
    summary: 'How to open a video.',
    body: 'Open with the question.',
    sources: [{ entryId: a }],
  })
  await change({
    op: 'create',
    address: 'audience/retention',
    type: 'topic',
    title: 'Retention',
    summary: 'What keeps viewers watching.',
    body: 'Long intros lose viewers. See [[audience/intros]] and [[drafts/hooks]].',
    tags: ['metric'],
    sources: [{ entryId: a }, { entryId: b }],
  })
  const edit = async (base: number, body: string) => {
    const r = await page.request.patch(`/v1/brains/${SLUG}/pages/audience/retention`, {
      headers: WEB,
      data: { baseRevision: base, body },
    })
    expect(r.status(), await r.text()).toBe(200)
  }
  await edit(1, 'Intros under ten seconds keep viewers. See [[audience/intros]] and [[drafts/hooks]].')
  await edit(
    2,
    'Intros under ten seconds keep viewers. Cut the greeting. See [[audience/intros]] and [[drafts/hooks]].',
  )
}

test('CA4: two sources; one opens beside the page without leaving it; a broken link says so', async ({
  page,
  request,
  baseURL,
}) => {
  await signedInAdmin(page, baseURL as string)
  await seed(page, request)
  await page.goto(`/b/${SLUG}`)
  await page
    .getByRole('navigation', { name: 'Sections of this brain' })
    .getByRole('link', { name: 'Wiki' })
    .click()
  await page.getByRole('link', { name: 'Retention', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${PAGE}$`))
  await expect(page.getByRole('heading', { level: 1, name: 'Retention' })).toBeVisible()
  await expect(page.locator('.page-meta')).toContainText('Revision 3')
  const sources = page.getByRole('region', { name: 'Sources' })
  await expect(sources.getByRole('button')).toHaveCount(2)
  const open = sources.getByRole('button', { name: 'The hook goes first' })
  await open.click()
  // Only ?source= is added; the page stays in the document.
  await expect(page).toHaveURL(new RegExp(`${PAGE}\\?source=ent_[\\w-]+$`))
  const panel = page.getByRole('dialog', { name: 'The hook goes first' })
  await expect(panel).toContainText('Start with the question of the video.')
  await expect(page.locator('.prose')).toContainText('Cut the greeting')
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(open).toBeFocused()
  await expect(page).toHaveURL(new RegExp(`${PAGE}$`))
  const broken = page.locator('.prose').getByRole('link', { name: /drafts\/hooks/ })
  await expect(broken).toContainText('(no page yet)')
  await broken.click()
  await expect(page.getByRole('heading', { level: 1, name: 'No page at drafts/hooks' })).toBeVisible()
})

test('history: revisions 1 to 3 compared word by word; a curator restores revision 1 as 4', async ({
  page,
  baseURL,
}) => {
  await signedInAdmin(page, baseURL as string)
  await page.goto(`${PAGE}?view=history&compare=1,3`)
  const diff = page.getByRole('region', { name: 'Changes from revision 1 to 3' })
  await expect(diff.locator('del').filter({ hasText: 'Long' })).not.toHaveCount(0)
  await expect(diff.locator('ins').filter({ hasText: 'greeting' })).not.toHaveCount(0)
  const list = page.getByRole('region', { name: 'Revisions' })
  await expect(list.getByRole('listitem')).toHaveCount(3)
  await expect(list.getByRole('listitem').nth(0)).toContainText('Revision 3 · edited by Eric')
  await list.getByRole('button', { name: 'Restore revision 1' }).click()
  await page
    .getByRole('dialog', { name: 'Restore revision 1?' })
    .getByRole('button', { name: 'Restore revision 1' })
    .click()
  await expect(
    page.getByRole('status').filter({ hasText: 'Restored revision 1 as revision 4.' }),
  ).toBeVisible()
  await expect(list.getByRole('listitem')).toHaveCount(4)
  // The log has a line for it.
  await page.goto(`/b/${SLUG}/wiki/log?kind=revert`)
  await expect(page.getByRole('list', { name: 'Changes' }).getByRole('listitem')).toHaveCount(1)
})

test('who read this: a curator sees the reads; a reader sees neither them nor the edit, and the API refuses', async ({
  page,
  browser,
  baseURL,
}) => {
  await signedInAdmin(page, baseURL as string)
  const reader = await person(browser, page, 'Rita', 'reader')
  const r = await reader.newPage()
  await r.goto(PAGE)
  await expect(r.getByRole('heading', { level: 1, name: 'Retention' })).toBeVisible()
  await expect(r.getByRole('region', { name: 'Who read this' })).toHaveCount(0)
  await expect(
    r.getByRole('navigation', { name: 'Views of this page' }).getByRole('link', { name: 'Edit' }),
  ).toHaveCount(0)
  await r.goto(`${PAGE}?view=edit`)
  await expect(r.getByText('Only curators of this brain edit its pages by hand.')).toBeVisible()
  const refused = await r.request.patch(`/v1/brains/${SLUG}/pages/audience/retention`, {
    headers: WEB,
    data: { baseRevision: 4, body: 'Not mine to change.' },
  })
  expect(refused.status()).toBe(403)
  expect(((await refused.json()) as { error: { howToProceed: string } }).error.howToProceed).toContain('Eric')
  await reader.close()
  // The curator sees Rita's read.
  await page.goto(PAGE)
  await expect(page.getByRole('region', { name: 'Who read this' })).toContainText('Rita')
})

test('CA10: two curators edit the same page; the second keeps their text and sees the new version', async ({
  page,
  browser,
  baseURL,
}) => {
  await signedInAdmin(page, baseURL as string)
  const eva = await person(browser, page, 'Eva', 'curator')
  const e = await eva.newPage()
  // Both open the editor on the same revision.
  await page.goto(`${PAGE}?view=edit`)
  await e.goto(`${PAGE}?view=edit`)
  const body = (p: Page) => p.getByLabel('Body', { exact: true })
  await expect(body(page)).toHaveValue(/Long intros lose viewers/)
  await expect(body(e)).toHaveValue(/Long intros lose viewers/)
  await body(e).fill('Eva: intros of five seconds. See [[audience/intros]].')
  await e.getByRole('button', { name: 'Save changes' }).click()
  await expect(e.getByRole('status').filter({ hasText: 'Saved as revision 5.' })).toBeVisible()
  await body(page).fill('Eric: the hook goes first, then the intro.')
  await page.getByRole('button', { name: 'Save changes' }).click()
  const conflict = page.getByRole('region', { name: 'Eva saved revision 5 while you edited' })
  await expect(conflict).toContainText('It is at revision 5 now. Nothing of yours was saved')
  await expect(
    conflict.getByRole('region', { name: 'What Eva changed' }).locator('ins').filter({ hasText: 'Eva' }),
  ).not.toHaveCount(0)
  await expect(conflict.getByLabel('Your text')).toHaveValue('Eric: the hook goes first, then the intro.')
  // Nothing is lost on a reload either.
  await page.reload()
  await expect(body(page)).toHaveValue('Eric: the hook goes first, then the intro.')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(conflict).toBeVisible()
  await conflict.getByRole('button', { name: 'Start again from theirs' }).click()
  await expect(body(page)).toHaveValue(/Eva: intros of five seconds/)
  await expect(page.getByLabel('Your text')).toHaveValue('Eric: the hook goes first, then the intro.')
  await body(page).fill('Eva: intros of five seconds. Eric: the hook goes first. See [[audience/intros]].')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Saved as revision 6.' })).toBeVisible()
  await expect(page.locator('.prose')).toContainText('Eric: the hook goes first')
  // The history names both curators.
  await page.goto(`${PAGE}?view=history`)
  const list = page.getByRole('region', { name: 'Revisions' })
  await expect(list.getByRole('listitem').nth(0)).toContainText('Revision 6 · edited by Eric')
  await expect(list.getByRole('listitem').nth(1)).toContainText('Revision 5 · edited by Eva')
  await eva.close()
})

test('the `[[` autocomplete reads the pages of the real wiki (G9)', async ({ page, baseURL }) => {
  await signedInAdmin(page, baseURL as string)
  await page.goto(`${PAGE}?view=edit`)
  const body = page.getByLabel('Body', { exact: true })
  await body.fill('See [[intr')
  await expect(
    page.getByRole('listbox', { name: 'Pages to link' }).getByRole('option', { name: /audience\/intros/ }),
  ).toBeVisible()
  await body.press('ArrowDown')
  await body.press('Enter')
  await expect(body).toHaveValue('See [[audience/intros]]')
})

// Review of PR19, on the real server: one visit is one read; Enter in a source field adds the source,
// found by its words; one Save sends the status with the rest and the history and the log say what it
// was and why; the map shows a stale page; two curators who both add a paragraph keep both.
test('one visit to a page is one read in «Who read this»', async ({ page, baseURL }) => {
  await signedInAdmin(page, baseURL as string)
  const reads = async () => {
    const r = await page.request.get(`/v1/brains/${SLUG}/trail?page=audience/retention&limit=200`)
    return ((await r.json()) as { items: { kind: string }[] }).items.filter((l) => l.kind === 'read').length
  }
  const before = await reads()
  await page.goto(PAGE)
  await expect(page.getByRole('region', { name: 'Recent changes' }).getByRole('listitem')).not.toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Who read this' }).getByRole('listitem')).not.toHaveCount(0)
  await page.waitForTimeout(500)
  expect(await reads()).toBe(before + 1)
  // Grouped: one line for Eric, however many times he read it.
  await expect(
    page.getByRole('region', { name: 'Who read this' }).getByRole('listitem').filter({ hasText: /^Eric/ }),
  ).toHaveCount(1)
})

test('one Save: a source found by its words with Enter, a status with ⌘ Enter; history and log say why', async ({
  page,
  baseURL,
}) => {
  await signedInAdmin(page, baseURL as string)
  await page.goto(`/b/${SLUG}/pages/audience/intros?view=edit`)
  const sources = page.getByRole('group', { name: 'Sources' })
  const entry = sources.getByLabel('Journal entry')
  await entry.fill('question')
  await expect(
    page
      .getByRole('listbox', { name: 'Journal entries' })
      .getByRole('option', { name: /The hook goes first/ }),
  ).toBeVisible()
  await entry.press('Enter')
  await expect(sources.getByRole('listitem').filter({ hasText: 'The hook goes first' })).toBeVisible()
  await expect(page).toHaveURL(/\?view=edit$/)
  await page.getByLabel('Status', { exact: true }).selectOption('stale')
  await page.getByLabel('Why (shown in the log)').fill('Needs the October numbers.')
  await page.getByLabel('Body', { exact: true }).press('ControlOrMeta+Enter')
  await expect(
    page.getByRole('status').filter({ hasText: 'Saved as revision 3. The page is stale now.' }),
  ).toBeVisible()
  await expect(
    page.getByRole('region', { name: 'Sources' }).getByRole('button', { name: 'The hook goes first' }),
  ).toBeVisible()
  await page.goto(`/b/${SLUG}/pages/audience/intros?view=history`)
  const list = page.getByRole('region', { name: 'Revisions' })
  await expect(list.getByRole('listitem').nth(0)).toContainText('Revision 3 · status → stale by Eric')
  await expect(list.getByRole('listitem').nth(0)).toContainText('Why: Needs the October numbers.')
  await expect(list.getByRole('listitem').nth(1)).toContainText('Revision 2 · edited by Eric')
  await page.goto(`/b/${SLUG}/wiki/log?kind=direct`)
  const line = page.getByRole('list', { name: 'Changes' }).getByRole('listitem').first()
  await expect(line).toContainText('Direct status → stale: audience/intros')
  await expect(line).toContainText('Why: Needs the October numbers.')
  // The map shows it, stale, and filters by status.
  await page.goto(`/b/${SLUG}/wiki?status=stale`)
  await expect(page.getByRole('listitem').filter({ hasText: 'Writing intros' }).locator('.tag')).toHaveText(
    'Stale',
  )
})

test('M4: two curators each add a paragraph; keeping both keeps both', async ({ page, browser, baseURL }) => {
  await signedInAdmin(page, baseURL as string)
  const ana = await person(browser, page, 'Ana', 'curator')
  const a = await ana.newPage()
  const body = (p: Page) => p.getByLabel('Body', { exact: true })
  await page.goto(`${PAGE}?view=edit`)
  await a.goto(`${PAGE}?view=edit`)
  const start = await body(page).inputValue()
  await expect(body(a)).toHaveValue(start)
  await body(a).fill(`${start}\n\nAna: thumbnails matter.`)
  await a.getByRole('button', { name: 'Save changes' }).click()
  await expect(a.getByRole('status').filter({ hasText: /Saved as revision \d+\./ })).toBeVisible()
  await body(page).fill(`${start}\n\nEric: the end screen matters.`)
  await page.getByRole('button', { name: 'Save changes' }).click()
  const conflict = page.getByRole('region', { name: /^Ana saved revision \d+ while you edited$/ })
  await expect(conflict.getByRole('radio', { name: 'Keep both' })).toBeChecked()
  const result = conflict.locator('[data-part="result-body"]')
  await expect(result).toContainText('Ana: thumbnails matter.')
  await expect(result).toContainText('Eric: the end screen matters.')
  await conflict.getByRole('button', { name: 'Save this result' }).click()
  await expect(page.getByRole('status').filter({ hasText: /Saved as revision \d+\./ })).toBeVisible()
  await expect(page.locator('.prose')).toContainText('Ana: thumbnails matter.')
  await expect(page.locator('.prose')).toContainText('Eric: the end screen matters.')
  await ana.close()
})
