// The profile and «Connect your agent» against the real server and PostgreSQL (plan T042–T043, PR24; local
// lane). CA1: a person without an account, holding an invitation, ends with their agent connected and the
// live check green, in 12 actions or fewer and in under 5 minutes, using only what is on screen. The agent is
// the real `rsc-brain bridge`, started with the token the person copied. Each action of the person is
// counted (a click, a field filled, the link of the email opened, the token pasted into the agent, the agent
// started). CA13 on the real server: a token made in the profile is never shown again. G6: a new password
// from the profile ends the person's other sessions.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'

const ADMIN = { name: 'Eric', email: 'eric@example.test', password: 'correct horse battery staple' }
const WEB = { 'x-requested-with': 'rsc-brain-web' }
const CLI = new URL('../../src/cli/main.ts', import.meta.url).pathname
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
  } else if (where === 'Sign in') {
    await page.getByLabel('Email').fill(ADMIN.email)
    await page.getByLabel('Password').fill(ADMIN.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Your brains' })).toBeVisible()
}

// The agent: the real bridge, over stdio, as a local agent starts it. Its token comes from the
// environment, never from the command line.
function startAgent(mcpUrl: string, token: string) {
  const p: ChildProcessWithoutNullStreams = spawn(process.execPath, [CLI, 'bridge', '--url', mcpUrl], {
    env: { PATH: process.env.PATH ?? '', HOME: tmpdir(), RSC_BRAIN_TOKEN: token },
    cwd: tmpdir(),
  })
  let out = ''
  let err = ''
  p.stdout.on('data', (d) => {
    out += d
  })
  p.stderr.on('data', (d) => {
    err += d
  })
  return {
    async initialize(): Promise<Record<string, unknown>> {
      p.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'agent', version: '1' },
          },
        })}\n`,
      )
      const end = Date.now() + 15_000
      while (Date.now() < end) {
        const line = out.split('\n').find((l) => l.includes('"id":1'))
        if (line) return JSON.parse(line) as Record<string, unknown>
        await new Promise((r) => setTimeout(r, 50))
      }
      throw new Error(`the bridge did not answer; stderr: ${err.slice(0, 300)}`)
    },
    stop: () => {
      p.stdin.end()
      p.kill()
    },
  }
}

test('CA1: from the invitation email to a connected agent, in 12 actions or fewer and under 5 minutes', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(320_000)
  await signedInAdmin(page, baseURL as string)
  // The installation's side, before the person: a brain and an invitation by email.
  const made = await page.request.post('/v1/brains', {
    headers: WEB,
    data: { slug: 'ca1', name: 'CA1', purpose: 'Where a new person connects an agent.' },
  })
  expect(made.status()).toBe(201)
  const email = `nora-${Date.now()}@example.test`
  const inv = await page.request.post('/v1/invitations', {
    headers: WEB,
    data: { emails: [email], brains: [{ slug: 'ca1', role: 'contributor' }] },
  })
  expect(inv.status()).toBe(201)
  const link = await mailLink(page.request, email)

  // The person: a browser of their own, which may copy (the clipboard of a real browser).
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const p = await ctx.newPage()
  let actions = 0
  const act = async <T>(f: () => Promise<T>): Promise<T> => {
    actions += 1
    return f()
  }
  const t0 = Date.now()
  await act(() => p.goto(link))
  await expect(p.getByRole('heading', { name: 'Accept your invitation' })).toBeVisible()
  await act(() => p.getByLabel('Your name').fill('Nora'))
  await act(() => p.getByLabel('Choose a password').fill('a long passphrase for nora'))
  await act(() => p.getByRole('button', { name: 'Create my account' }).click())
  await expect(p.getByRole('heading', { level: 1, name: 'Your brains' })).toBeVisible()
  await act(() => p.getByRole('main').getByRole('link', { name: 'Connect your agent' }).click())
  await expect(p.getByRole('tab', { name: 'Claude Code' })).toHaveAttribute('aria-selected', 'true')
  const check = p.getByRole('region', { name: 'Live check' })
  await expect(check).toContainText('Waiting for your agent…')
  await act(() => p.getByRole('button', { name: 'Create a token and fill in the configuration' }).click())
  await act(() => p.getByRole('button', { name: 'Copy the token' }).click())
  await expect(p.getByRole('region', { name: 'Your new token' }).getByText('Copied.')).toBeVisible()
  // Pasting it into the agent, and starting the agent: two actions of the person.
  const token = await act(() => p.evaluate(() => navigator.clipboard.readText()))
  expect(token).toMatch(/^rscb_/)
  const agent = await act(async () => startAgent(`${baseURL}/mcp`, token))
  try {
    const init = await agent.initialize()
    expect(init.error, JSON.stringify(init.error)).toBeUndefined()
    await expect(check).toContainText('Connected', { timeout: 15_000 })
    await expect(check).toContainText('reached rsc-brain')
  } finally {
    agent.stop()
  }
  const seconds = (Date.now() - t0) / 1000
  mkdirSync(dirname(MEASURES), { recursive: true })
  writeFileSync(MEASURES, `CA1: ${actions} actions, ${seconds.toFixed(1)} s (limit 12 actions, 300 s)\n`)
  expect(actions).toBeLessThanOrEqual(12)
  expect(seconds).toBeLessThan(300)
  // Done: the token is hidden, and the profile lists it, used, by its last 4 characters only.
  await p.getByRole('button', { name: 'Done, hide the token' }).click()
  await expect(p.locator('body')).not.toContainText(token)
  await p.getByRole('link', { name: 'your profile' }).click()
  const row = p.getByRole('region', { name: 'Tokens' }).getByRole('listitem').first()
  await expect(row).toContainText(`…${token.slice(-4)}`)
  await expect(row).toContainText(/Used just now/)
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
