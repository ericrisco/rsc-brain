// The profile and «Connect your agent» against the real server and PostgreSQL (plan T042–T043, PR24; local
// lane). CA1: a person without an account, holding an invitation, ends with their agent connected and the
// live check green, in 12 actions or fewer and in under 5 minutes, using only what is on screen. The script
// follows the screen exactly and counts every action of the person: opening the email link, every field
// typed, click, copy, paste, key that sends, and file saved. What the agent does by itself (open the
// browser, exchange the code, make its first request) is not the person's and is not counted.
// The standard route (recommended) must fit in 12; the token route is the alternative and its count is
// reported, not bounded. CA13 on the real server: a token made in the profile is never shown again. G6: a
// new password from the profile ends the person's other sessions.
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test'
import { keepTheKey } from './key.ts'

const ADMIN = { name: 'Eric', email: 'eric@example.test', password: 'correct horse battery staple' }
const WEB = { 'x-requested-with': 'rsc-brain-web' }
const MEASURES = new URL('../../test-results/ca1.txt', import.meta.url).pathname

test.describe.configure({ mode: 'serial' })

async function mailLink(request: APIRequestContext, to: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const r = await request.get(`/__e2e/mail?to=${encodeURIComponent(to)}`)
    if (r.ok()) {
      const m = (await r.json()) as { text: string }
      const link = /https?:\/\/\S+\/invite#token=[\w-]+/.exec(m.text)?.[0]
      if (link) return new URL(link).pathname + new URL(link).hash
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`no invitation mail to ${to}`)
}

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

// An invited person, from the email onward: the first five actions are the same on both routes.
async function invitedToConnect(browser: Browser, admin: Page, name: string) {
  const email = `${name.toLowerCase()}-${Date.now()}@example.test`
  const inv = await admin.request.post('/v1/invitations', {
    headers: WEB,
    data: { emails: [email], brains: [{ slug: 'ca1', role: 'contributor' }] },
  })
  expect(inv.status()).toBe(201)
  const link = await mailLink(admin.request, email)
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const p = await ctx.newPage()
  const steps: string[] = []
  const act = async <T>(what: string, f: () => Promise<T>): Promise<T> => {
    steps.push(what)
    return f()
  }
  const t0 = Date.now()
  await act('open the link of the email', () => p.goto(link))
  await expect(p.getByRole('heading', { name: 'Accept your invitation' })).toBeVisible()
  await act('type the name', () => p.getByLabel('Your name').fill(name))
  await act('type a password', () => p.getByLabel('Choose a password').fill(`a long passphrase for ${name}`))
  await act('click «Create my account»', () => p.getByRole('button', { name: 'Create my account' }).click())
  await expect(p.getByRole('heading', { level: 1, name: 'Your brains' })).toBeVisible()
  await act('click «Connect your agent»', () =>
    p.getByRole('main').getByRole('link', { name: 'Connect your agent' }).click(),
  )
  await expect(p.getByRole('tab', { name: 'Claude Code' })).toHaveAttribute('aria-selected', 'true')
  await expect(p.getByRole('region', { name: 'Live check' })).toContainText('Waiting for your agent…')
  return { ctx, p, steps, act, t0 }
}

const clipboard = (p: Page) => p.evaluate(() => navigator.clipboard.readText())

// What Claude Code does with the standard sign-in, as the standard asks: it registers, opens the person's
// browser at the consent page, takes the code back on this computer, and exchanges it with its proof.
async function claudeCodeSignsIn(browser: { newPage(): Promise<Page> }, base: string) {
  const codes: string[] = []
  const back = createServer((req, res) => {
    const code = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('code')
    if (code) codes.push(code)
    res
      .writeHead(200, { 'content-type': 'text/plain' })
      .end('Authentication complete. You may close this window.')
  })
  await new Promise<void>((r) => back.listen(0, '127.0.0.1', r))
  const redirect = `http://127.0.0.1:${(back.address() as AddressInfo).port}/callback`
  const reg = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude Code',
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
    }),
  })
  const client = String(((await reg.json()) as { client_id: string }).client_id)
  const verifier = randomBytes(40).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const consent = await browser.newPage()
  await consent.goto(
    `${base}/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: client,
      redirect_uri: redirect,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'ca1',
      resource: `${base}/mcp`,
      scope: 'brain:read brain:write',
    })}`,
  )
  return {
    consent,
    async exchange(): Promise<string> {
      await expect.poll(() => codes.length).toBe(1)
      const t = await fetch(`${base}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: codes[0] as string,
          code_verifier: verifier,
          redirect_uri: redirect,
          client_id: client,
          resource: `${base}/mcp`,
        }).toString(),
      })
      back.close()
      return ((await t.json()) as { access_token: string }).access_token
    },
  }
}

// An MCP client's first request, as Claude Code makes it when it starts.
const initialize = (base: string, key: string, client = 'claude-code/2.1.3') =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${key}`,
      'user-agent': client,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'claude-code', version: '2.1.3' },
      },
    }),
  })

test('CA1, standard route: from the invitation email to a connected Claude Code, in 12 actions or fewer', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(320_000)
  const base = baseURL as string
  await signedInAdmin(page, base)
  const made = await page.request.post('/v1/brains', {
    headers: WEB,
    data: { slug: 'ca1', name: 'CA1', purpose: 'Where a new person connects an agent.' },
  })
  expect(made.status()).toBe(201)
  const { ctx, p, steps, act, t0 } = await invitedToConnect(browser, page, 'Nora')
  const panel = p.getByRole('tabpanel', { name: 'Claude Code' })
  const standard = panel.getByRole('region', { name: 'Standard connection' })
  await expect(standard).toContainText('Recommended')
  await act('click «Copy» on the command', () =>
    standard.getByRole('button', { name: 'Copy: Add rsc-brain for all your projects and sign in' }).click(),
  )
  const command = await clipboard(p)
  expect(command).toBe(
    `claude mcp add --transport http rsc-brain ${base}/mcp --scope user\nclaude mcp login rsc-brain`,
  )
  await act('paste it in a terminal', async () => {})
  // Enter runs both lines: the server is added, and the sign-in opens the browser at the consent page.
  const agent = await act('press Enter', () => claudeCodeSignsIn(ctx, base))
  // The consent page starts from the brain of her invitation, with read and write: one click.
  await expect(agent.consent.getByRole('checkbox', { name: /CA1/ })).toBeChecked()
  await expect(agent.consent.getByRole('radio', { name: /Read and write/ })).toBeChecked()
  await act('click «Approve»', () => agent.consent.getByRole('button', { name: 'Approve' }).click())
  const key = await agent.exchange()
  // The exchange alone is not the agent reaching rsc-brain.
  await p.waitForTimeout(2_500)
  await expect(p.getByRole('region', { name: 'Live check' })).toContainText('Waiting for your agent…')
  await act('type «claude» in the terminal', async () => {})
  const first = await act('press Enter (Claude Code starts and connects)', () => initialize(base, key))
  expect(first.status).toBe(200)
  const check = p.getByRole('region', { name: 'Live check' })
  await expect(check).toContainText('Connected', { timeout: 15_000 })
  await expect(check).toContainText('Claude Code reached rsc-brain')
  const seconds = (Date.now() - t0) / 1000
  mkdirSync(dirname(MEASURES), { recursive: true })
  writeFileSync(
    MEASURES,
    `CA1 standard route: ${steps.length} actions, ${seconds.toFixed(1)} s (limit 12 actions, 300 s)\n${steps.map((x, i) => `  ${i + 1}. ${x}`).join('\n')}\n`,
  )
  expect(steps.length).toBeLessThanOrEqual(12)
  expect(seconds).toBeLessThan(300)
  await ctx.close()
})

test('CA1, token route (the alternative): the same person path, counted honestly, with a working agent', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(320_000)
  const base = baseURL as string
  await signedInAdmin(page, base)
  const { ctx, p, steps, act, t0 } = await invitedToConnect(browser, page, 'Tomas')
  const panel = p.getByRole('tabpanel', { name: 'Claude Code' })
  const tokenPart = panel.getByRole('region', { name: 'Token connection' })
  await act('click «Create a token»', () => tokenPart.getByRole('button', { name: 'Create a token' }).click())
  const once = tokenPart.getByRole('region', { name: 'Your new token' })
  // A terminal of a computer of her own: a home of its own.
  const home = mkdtempSync(join(tmpdir(), 'ca1-home-'))
  const shell = (script: string, input = '') =>
    execFileSync('bash', ['-c', script], {
      env: { PATH: process.env.PATH ?? '', HOME: home },
      input,
    }).toString()
  try {
    const block = (title: RegExp) => once.locator('.cmd-block').filter({ has: p.getByText(title) })
    await act('click «Copy» on the command that saves the token', () =>
      block(/^Save the token/)
        .getByRole('button', { name: /^Copy: Save the token/ })
        .click(),
    )
    const save = await clipboard(p)
    expect(save).toContain('read -rs t')
    await act('paste it in a terminal', async () => {})
    await act('press Enter (a hidden prompt asks for the token)', async () => {})
    await act('click «Copy the token»', () => once.getByRole('button', { name: 'Copy the token' }).click())
    const token = await clipboard(p)
    await act('paste the token at the hidden prompt', async () => {})
    await act('press Enter', async () => shell(save, `${token}\n`))
    await act('click «Copy» on the line that loads it', () =>
      block(/^Load it in your shell/)
        .getByRole('button', { name: /^Copy: Load it/ })
        .click(),
    )
    const load = await clipboard(p)
    await act('open the shell profile in an editor', async () => {})
    await act('paste the line', async () => {})
    await act('save the file', async () => writeFileSync(join(home, '.bashrc'), `${load}\n`))
    await act('open a new terminal', async () => {})
    await act('click «Copy» on the .mcp.json', () =>
      block(/^Add rsc-brain to a project/)
        .getByRole('button', { name: /^Copy: Add rsc-brain to a project/ })
        .click(),
    )
    const mcpJson = await clipboard(p)
    await act('create .mcp.json in the project', async () => {})
    await act('paste it', async () => {})
    await act('save the file', async () => writeFileSync(join(home, '.mcp.json'), mcpJson))
    await act('type «claude»', async () => {})
    // Claude Code reads .mcp.json and expands the variable from the new terminal's environment.
    const header = (
      JSON.parse(readFileSync(join(home, '.mcp.json'), 'utf8')) as {
        mcpServers: Record<string, { headers: { Authorization: string } }>
      }
    ).mcpServers['rsc-brain']?.headers.Authorization
    const expanded = shell(`source ~/.bashrc && printf '%s' "${header}"`)
    expect(expanded).toBe(`Bearer ${token}`)
    const first = await act('press Enter (Claude Code starts and connects)', () =>
      initialize(base, expanded.slice('Bearer '.length)),
    )
    expect(first.status).toBe(200)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
  const check = p.getByRole('region', { name: 'Live check' })
  await expect(check).toContainText('Connected', { timeout: 15_000 })
  const seconds = (Date.now() - t0) / 1000
  mkdirSync(dirname(MEASURES), { recursive: true })
  writeFileSync(
    MEASURES,
    `${existsSync(MEASURES) ? readFileSync(MEASURES, 'utf8') : ''}CA1 token route: ${steps.length} actions, ${seconds.toFixed(1)} s (reported; the alternative)\n${steps.map((x, i) => `  ${i + 1}. ${x}`).join('\n')}\n`,
  )
  // Done: the token is hidden; the profile lists it, used, by its last 4 characters only.
  await tokenPart.getByRole('button', { name: 'Done, hide the token' }).click()
  await p.getByRole('link', { name: 'your profile' }).click()
  await expect(p.getByRole('region', { name: 'Tokens' }).getByRole('listitem').first()).toContainText(
    /Used just now/,
  )
  await ctx.close()
})

test('CA13: a token made in the profile is shown once, then never again, on the real server', async ({
  page,
  baseURL,
}) => {
  await signedInAdmin(page, baseURL as string)
  await page.goto('/profile')
  const tokens = page.getByRole('region', { name: 'Tokens' })
  await tokens.getByRole('button', { name: 'Create a token' }).click()
  await tokens.getByLabel('Name').fill('CA13 e2e')
  await tokens.getByLabel('Read only').check()
  await tokens.getByRole('button', { name: 'Create token' }).click()
  const once = tokens.getByRole('region', { name: 'Your new token' })
  const secret = String(await once.locator('pre code').textContent()).trim()
  expect(secret).toMatch(/^rscb_/)
  await once.getByRole('button', { name: 'Done, hide the token' }).click()
  await expect(once).toHaveCount(0)
  const kept = await page.evaluate(
    () =>
      document.documentElement.outerHTML +
      [...document.querySelectorAll('input, textarea')].map((x) => (x as HTMLInputElement).value).join() +
      JSON.stringify({ ...sessionStorage }) +
      JSON.stringify({ ...localStorage }) +
      location.href +
      JSON.stringify(history.state),
  )
  expect(kept.includes(secret)).toBe(false)
  // Nor in the API: the list has its last 4 characters only.
  const listed = await page.request.get('/v1/me/tokens')
  const text = await listed.text()
  expect(text.includes(secret)).toBe(false)
  expect(text).toContain(secret.slice(-4))
  // It works, and revoking it from the profile stops it at the next request.
  expect(
    (await page.request.get('/v1/me', { headers: { authorization: `Bearer ${secret}` } })).status(),
  ).toBe(200)
  const row = tokens.getByRole('listitem').filter({ hasText: 'CA13 e2e' })
  await row.getByRole('button', { name: 'Revoke' }).click()
  await row.getByRole('button', { name: 'Revoke CA13 e2e' }).click()
  await expect(tokens.getByRole('status')).toContainText('CA13 e2e is revoked.')
  const after = await page.request.get('/v1/me', { headers: { authorization: `Bearer ${secret}` } })
  expect(after.status()).toBe(401)
})

test('G6: a new password from the profile signs the person out of their other sessions', async ({
  page,
  browser,
  baseURL,
}) => {
  await signedInAdmin(page, baseURL as string)
  const email = `pia-${Date.now()}@example.test`
  const inv = await page.request.post('/v1/invitations', { headers: WEB, data: { emails: [email] } })
  const token = /#token=([\w-]+)/.exec(
    ((await inv.json()) as { invitations: Array<{ link: string }> }).invitations[0]?.link ?? '',
  )?.[1]
  const elsewhere = await browser.newContext()
  const accepted = await elsewhere.request.post('/v1/invitations/accept', {
    headers: WEB,
    data: { token, name: 'Pia', password: ADMIN.password },
  })
  expect(accepted.status()).toBe(201)
  const here = await browser.newContext()
  const p = await here.newPage()
  await p.goto('/sign-in')
  await p.getByLabel('Email').fill(email)
  await p.getByLabel('Password').fill(ADMIN.password)
  await p.getByRole('button', { name: 'Sign in' }).click()
  await expect(p.getByRole('heading', { level: 1, name: 'Your brains' })).toBeVisible()
  await p.goto('/profile')
  const form = p.getByRole('form', { name: 'Change your password' })
  await form.getByLabel('Current password').fill(ADMIN.password)
  await form.getByLabel('New password').fill('a brand new passphrase for pia')
  await form.getByRole('button', { name: 'Change password' }).click()
  await expect(form.getByRole('status')).toContainText('Password changed.')
  expect((await p.request.get('/v1/me')).status()).toBe(200)
  expect((await elsewhere.request.get('/v1/me')).status()).toBe(401)
  await here.close()
  await elsewhere.close()
})
