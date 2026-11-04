// Spec B6 «Sign in · First run · Accept invitation» and B4: the screens before a session, used in a real
// browser against the fixture API (plan T009). Each test walks the job and its failures.
import { CODE, expect, INVITE, keepTheKey, PASSWORD, RESET, scenario, test } from './fixture.ts'

test.describe('sign in', () => {
  test('returns to where the person was going; a wrong password keeps the email and puts the keyboard on the password', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-out')
    await page.goto('/b/growth')
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fb%2Fgrowth$/)
    await page.getByLabel('Email').fill('eric@example.test')
    await page.getByLabel('Password').fill('not the password')
    await page.getByLabel('Password').press('Enter')
    await expect(page.getByRole('alert')).toContainText('The email or the password is not right.')
    await expect(page.getByRole('alert')).toContainText('reset your password')
    await expect(page.getByLabel('Email')).toHaveValue('eric@example.test')
    await expect(page.getByLabel('Password')).toBeFocused()
    await expect(page.getByLabel('Password')).toHaveValue('')
    await page.keyboard.type(PASSWORD)
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/b\/growth$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Growth' })).toBeVisible()
  })

  test('asks for the authenticator code when the account has one', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-out')
    await page.goto('/sign-in')
    await page.getByLabel('Email').fill('ana@example.test')
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible()
    const code = page.getByLabel('Code from your authenticator app')
    await expect(code).toBeFocused()
    await code.fill('000000')
    await code.press('Enter')
    await expect(page.getByRole('alert')).toContainText('The code is not right')
    await expect(code).toBeFocused()
    await code.fill(CODE)
    await code.press('Enter')
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole('heading', { name: 'Your brains' })).toBeVisible()
  })

  test('after five failures in a row, says how long to wait', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-out')
    await page.goto('/sign-in')
    await page.getByLabel('Email').fill('eric@example.test')
    for (let i = 0; i < 6; i++) {
      await page.getByLabel('Password').fill('wrong wrong wrong')
      await page.getByLabel('Password').press('Enter')
      await expect(page.getByRole('alert')).toBeVisible()
    }
    await expect(page.getByRole('alert')).toContainText('Too many failed attempts')
  })

  test('a slow sign-in shows it is in progress and cannot be sent twice', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-out', { 'sign-in': 'loading' })
    let sent = 0
    page.on('request', (r) => {
      if (r.url().endsWith('/v1/auth/login')) sent++
    })
    await page.goto('/sign-in')
    await page.getByLabel('Email').fill('eric@example.test')
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
    const busy = page.getByRole('button', { name: 'Signing in…' })
    await expect(busy).toHaveAttribute('aria-busy', 'true')
    // Pressed again, by pointer and by keyboard: still one request.
    await busy.click({ force: true })
    await page.getByLabel('Password').press('Enter')
    await expect(page.getByRole('heading', { name: 'Your brains' })).toBeVisible({ timeout: 10_000 })
    expect(sent).toBe(1)
  })

  test('offline: a strip says so and signing in is off, with the reason', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-out')
    await page.goto('/sign-in')
    await context.setOffline(true)
    await expect(page.getByRole('status').filter({ hasText: 'You are offline' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in' })).toHaveAttribute('aria-disabled', 'true')
    await expect(
      page.getByText('You are offline: this cannot be sent until the connection is back.'),
    ).toBeVisible()
    await context.setOffline(false)
    await expect(page.getByRole('button', { name: 'Sign in' })).not.toHaveAttribute('aria-disabled', 'true')
  })
})

test.describe('first run', () => {
  test('until set up, every address leads to the setup; setting up signs the administrator in', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'fresh')
    await page.goto('/b/growth')
    await expect(page).toHaveURL(/\/setup$/)
    await expect(page.getByRole('heading', { name: 'Set up rsc-brain' })).toBeVisible()
    await page.getByLabel('Name of this installation').fill('rsc-brain')
    await expect(page.getByLabel('Address people open')).toHaveValue(baseURL as string)
    await page.getByLabel('Your name').fill('Eric')
    await page.getByLabel('Your email').fill('eric@example.test')
    await page.getByLabel('Password', { exact: true }).fill('too short')
    await page.getByRole('button', { name: 'Set up and sign in' }).click()
    // Checked in the browser first: the problem sits next to the field, which takes the keyboard.
    await expect(page.getByLabel('Password', { exact: true })).toHaveAccessibleDescription(
      /at least 12 characters/,
    )
    await expect(page.getByLabel('Password', { exact: true })).toBeFocused()
    await expect(page.getByLabel('Your email')).toHaveValue('eric@example.test')
    await page.getByRole('button', { name: 'Show' }).click()
    await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text')
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Set up and sign in' }).click()
    await keepTheKey(page)
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole('link', { name: /rsc-brain/ })).toBeVisible()
    await page.goto('/setup')
    await expect(page.getByRole('heading', { name: 'rsc-brain is already set up' })).toBeVisible()
  })

  test('installed with rsc-factory: says to finish there, links to it, asks for nothing; then leads to sign in', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(
      context,
      baseURL as string,
      'fresh',
      {},
      {
        companion: true,
        factoryUrl: 'https://factory.example.test',
      },
    )
    await page.goto('/b/growth')
    await expect(page).toHaveURL(/\/setup$/)
    await expect(page.getByRole('heading', { name: 'Finish the setup in rsc-factory' })).toBeVisible()
    await expect(page.getByText('rsc-brain was installed with rsc-factory')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open rsc-factory' })).toHaveAttribute(
      'href',
      'https://factory.example.test',
    )
    await expect(page.locator('input')).toHaveCount(0)
    // Checking again while rsc-factory has not finished: busy while it asks, then said aloud (a live region).
    await s.state('setup', 'loading')
    await page.getByRole('button', { name: 'Check again' }).click()
    await expect(page.getByRole('button', { name: 'Checking…' })).toHaveAttribute('aria-busy', 'true')
    await expect(page.getByRole('status')).toHaveText('Still waiting for rsc-factory.')
    await expect(page.getByRole('heading', { name: 'Finish the setup in rsc-factory' })).toBeVisible()
    await s.state('setup', 'normal')
    // At 320 px nothing goes past the edge.
    await page.setViewportSize({ width: 320, height: 700 })
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
    ).toBe(true)
    // rsc-factory finishes its setup meanwhile: checking again leads to signing in.
    await s.setUpElsewhere()
    await page.getByRole('button', { name: 'Check again' }).click()
    await expect(page.getByRole('heading', { name: 'rsc-brain is already set up' })).toBeVisible()
  })

  test('over a connection that is not safe, it explains and does not ask for a password', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'insecure')
    await page.goto('/setup')
    await expect(page.getByRole('alert')).toContainText('This connection is not safe for a password')
    await expect(page.getByRole('alert')).toContainText('http://localhost')
    await expect(page.locator('input[type="password"]')).toHaveCount(0)
  })
})

test.describe('accept an invitation', () => {
  test('shows what it offers, takes the token out of the address, and signs the person in', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-out')
    await page.goto(`/invite#token=${INVITE}`)
    await expect(page.getByRole('heading', { name: 'Accept your invitation' })).toBeVisible()
    await expect(page).toHaveURL(/\/invite$/)
    expect(await page.evaluate(() => location.href)).not.toContain(INVITE)
    await expect(page.getByText('marta@example.test')).toBeVisible()
    await expect(page.getByText('Growth')).toBeVisible()
    await expect(page.getByText('contributor')).toBeVisible()
    await page.getByLabel('Your name').fill('Marta')
    await page.getByLabel('Choose a password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Create my account' }).click()
    await expect(page.getByRole('heading', { name: 'Your brains' })).toBeVisible()
    expect(
      await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage })),
    ).not.toContain(INVITE)
  })

  // Review of PR18, P5: a reload in the same tab keeps the invitation (held in this tab's history entry,
  // never in the address or in storage); once accepted it is gone.
  test('P5: a reload in the same tab keeps the invitation until it is accepted', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-out')
    await page.goto(`/invite#token=${INVITE}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Accept your invitation' })).toBeVisible()
    await expect(page).toHaveURL(/\/invite$/)
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: 'Accept your invitation' })).toBeVisible()
    await expect(page).toHaveURL(/\/invite$/)
    const kept = await page.evaluate(
      () => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }) + location.href,
    )
    expect(kept).not.toContain(INVITE)
    await page.getByLabel('Your name').fill('Zoe')
    await page.getByLabel('Choose a password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Create my account' }).click()
    await expect(page.getByRole('heading', { name: 'Your brains' })).toBeVisible()
    expect(await page.evaluate(() => JSON.stringify(history.state ?? null))).not.toContain(INVITE)
    // Back on the invite page in this tab: the invitation is no longer held.
    await page.goto('/invite')
    await expect(page.getByLabel('Choose a password')).toHaveCount(0)
    await expect(page.getByText('This address has no invitation in it')).toBeVisible()
  })

  test('a used or wrong link says it does not work and who to ask', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-out')
    await page.goto('/invite#token=inv_not_a_real_token_000')
    await expect(page.getByRole('alert')).toContainText('This invitation link is not valid')
    await expect(page.getByRole('alert')).toContainText('Ask an administrator to send a new one.')
  })

  test('without a token, it says to open the link from the email', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-out')
    await page.goto('/invite')
    await expect(page.getByRole('alert')).toContainText('Open the link from your invitation email again.')
  })
})

test.describe('reset a password', () => {
  test('asks for a link and says the same whatever the email', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-out')
    await page.goto('/sign-in')
    await page.getByRole('link', { name: 'Forgot your password?' }).click()
    await page.getByLabel('Email').fill('someone@example.test')
    await page.getByRole('button', { name: 'Send the link' }).click()
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeFocused()
    await expect(page.getByText('If that email has an account')).toBeVisible()
  })

  test('chooses a new password with the link, once', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-out')
    await page.goto(`/reset#token=${RESET}`)
    await expect(page).toHaveURL(/\/reset$/)
    await page.getByLabel('New password').fill('a new long passphrase')
    await page.getByRole('button', { name: 'Save the new password' }).click()
    await expect(page.getByRole('heading', { name: 'Your password is changed' })).toBeFocused()
    // The same link again, opened anew from the email: refused on arrival, before anyone types.
    await page.goto('/sign-in')
    await page.goto(`/reset#token=${RESET}`)
    await expect(page.getByRole('alert')).toContainText('This reset link is not valid')
    await expect(page.getByLabel('New password')).toHaveCount(0)
  })
})

// Review of PR19 (C4): what arrives late never takes the keyboard from a field the person is in. Each test
// fails with its rule taken out: an error that shows while a filter is being chosen (focusOnArrival), and a
// page that turns out to have moved while its editor is being typed in (the field rule of a move between
// screens, lib/screen.ts).
test.describe('the keyboard stays where the person is', () => {
  test('an error that arrives while choosing a filter leaves the filter focused', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.route('**/v1/brains/growth/wiki/log?*kind=direct*', (route) =>
      route.fulfill({
        status: 500,
        json: { error: { code: 'internal', message: 'Something went wrong.', howToProceed: 'Try again.' } },
      }),
    )
    await page.goto('/b/growth/wiki/log')
    await expect(page.getByRole('list', { name: 'Changes' })).toBeVisible()
    const kind = page.getByLabel('Kind of change')
    await kind.focus()
    await kind.selectOption('direct')
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
    await expect(kind).toBeFocused()
  })

  test('a page found moved while its editor is typed in keeps the typing', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/pages/audience/retention?view=edit')
    await expect(page.getByLabel('Body', { exact: true })).toBeVisible()
    await page
      .getByRole('navigation', { name: 'Where this page is' })
      .getByRole('link', { name: 'Wiki' })
      .click()
    await expect(page.getByRole('heading', { level: 1, name: 'Wiki' })).toBeVisible()
    // Another curator moves the page; this browser still holds it at its old address.
    await fetch(`${baseURL}/__fixture/scenarios/${s.id}/wiki-edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brain: 'growth', address: 'audience/retention', to: 'audience/kept' }),
    })
    let release = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    await page.route('**/v1/brains/growth/pages/audience/retention?include=history', async (route) => {
      await held
      await route.fallback()
    })
    // Back to the editor: what this browser holds shows at once, and is asked for again.
    await page.goBack()
    const body = page.getByLabel('Body', { exact: true })
    await body.focus()
    await body.fill('First words. ')
    release()
    await expect(page).toHaveURL(/\/pages\/audience\/kept\?view=edit$/)
    await page.waitForTimeout(300)
    await page.keyboard.type('More words.')
    await expect(body).toHaveValue('First words. More words.')
    await expect(body).toBeFocused()
  })
})
