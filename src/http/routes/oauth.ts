// The standard sign-in of MCP (spec B4 «Conexiones»): the metadata agents read to find it, dynamic
// registration, the sign-in and consent pages, the code exchange and refresh, and revocation. The pages
// cannot be framed by another site, and consenting needs a token tied to the person's session.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { type Principal, resolveKey } from '../../auth/principal.ts'
import { AppError } from '../../core/errors.ts'
import {
  type AuthzRequest,
  checkClientAndReturn,
  checkRequest,
  consentBrains,
  exchangeCode,
  hostOf,
  issueCode,
  issuer,
  OAuthError,
  refreshGrant,
  registerClient,
  resourceOf,
  revokeByToken,
} from '../../domain/connections.ts'
import { signIn } from '../../domain/login.ts'
import { obj } from '../input.ts'
import { type PublicReq, publicRoute, type Reply, type Route } from '../router.ts'
import { cookie } from './auth.ts'

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  'referrer-policy': 'no-referrer',
}
const FORM_COOKIE = 'rscb_form'

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )

// Forms are signed with the installation secret (or, without one, a key that lives as long as the process).
const PROCESS_KEY = randomBytes(32).toString('hex')
const sign = (r: PublicReq, what: string) =>
  createHmac('sha256', r.secret ?? PROCESS_KEY)
    .update(what)
    .digest('base64url')
const sameText = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function page(
  title: string,
  body: string,
  status = 200,
  headers: Record<string, string | string[]> = {},
): Reply {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · RSC Brain</title><style>
:root{color-scheme:light dark;--fg:#1b1d1f;--muted:#5d6166;--bg:#f6f5f1;--card:#fff;--line:#dcd9d2;--accent:#1f5f4a;--warn:#8a4b00;--warnbg:#fff4e0}
@media (prefers-color-scheme:dark){:root{--fg:#ecebe7;--muted:#a3a7ab;--bg:#141516;--card:#1d1f21;--line:#33363a;--accent:#7cc4a6;--warn:#f2b46a;--warnbg:#2b2214}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:30rem;margin:8vh auto;padding:0 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:1.35rem;margin:0 0 4px}p{margin:8px 0}.muted{color:var(--muted);font-size:.9rem}
label{display:block;margin:14px 0 4px;font-weight:600;font-size:.9rem}input[type=email],input[type=password],input[type=text]{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
fieldset{border:1px solid var(--line);border-radius:8px;margin:14px 0;padding:8px 12px}legend{font-weight:600;font-size:.9rem;padding:0 4px}
.opt{display:flex;gap:8px;align-items:baseline;margin:6px 0;font-weight:400}.warn{background:var(--warnbg);color:var(--warn);border-radius:8px;padding:10px 12px;font-size:.9rem;margin:12px 0}
.domain{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:700}.row{display:flex;gap:10px;margin-top:18px}
button{flex:1;padding:11px;border-radius:8px;border:1px solid var(--line);font:inherit;font-weight:600;cursor:pointer;background:transparent;color:inherit}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--bg)}button:focus-visible,input:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.error{color:#b3261e;font-weight:600}@media (prefers-color-scheme:dark){.error{color:#ff8a80}}
</style></head><body><main><div class="card">${body}</div><p class="muted">RSC Brain</p></main></body></html>`
  return { status, body: html, headers: { ...PAGE_HEADERS, ...headers } }
}

const errorPage = (message: string, status = 400) =>
  page(
    'Cannot connect',
    `<h1>This app cannot connect</h1><p class="error">${esc(message)}</p><p class="muted">Nothing was shared. Close this page and check the app's settings.</p>`,
    status,
  )

// The query of the request, refusing a parameter given twice (the standard asks for that).
function queryOf(q: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of q) {
    if (Object.hasOwn(out, k)) throw new OAuthError(400, 'invalid_request', `"${k}" is given more than once.`)
    out[k] = v
  }
  return out
}

const AUTHZ_KEYS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'state',
  'code_challenge',
  'code_challenge_method',
  'resource',
  'scope',
]
const hidden = (q: Record<string, string>) =>
  AUTHZ_KEYS.filter((k) => q[k] !== undefined)
    .map((k) => `<input type="hidden" name="${k}" value="${esc(q[k] as string)}">`)
    .join('')

function back(redirectUri: string, params: Record<string, string | null>): Reply {
  const u = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v)
  return {
    status: 303,
    body: '',
    headers: { location: u.toString(), 'content-type': 'text/plain', 'referrer-policy': 'no-referrer' },
  }
}

async function personOf(r: PublicReq): Promise<Principal | null> {
  if (!r.cookie) return null
  try {
    const p = await resolveKey(r.db, r.cookie, r.clock(), 'cookie', r.conn)
    return p.kind === 'person' && p.credential.kind === 'web' ? p : null
  } catch {
    return null
  }
}

function loginPage(
  r: PublicReq,
  q: Record<string, string>,
  clientName: string,
  message?: string,
  status = 200,
): Reply {
  const nonce = randomBytes(16).toString('base64url')
  const params = new URLSearchParams(q).toString()
  return page(
    'Sign in',
    `<h1>Sign in to connect</h1><p><strong>${esc(clientName)}</strong> wants to connect to your brains. Sign in first.</p>
${message ? `<p class="error" role="alert">${esc(message)}</p>` : ''}
<form method="post" action="/oauth/login">
<input type="hidden" name="nonce" value="${nonce}"><input type="hidden" name="csrf" value="${sign(r, `login:${nonce}`)}">
<input type="hidden" name="continue" value="${esc(params)}">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required autofocus>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<label for="code">Code from your authenticator app <span class="muted">(only if you set one up)</span></label><input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code">
<div class="row"><button class="primary" type="submit">Sign in</button></div></form>`,
    status,
    {
      'set-cookie': `${FORM_COOKIE}=${nonce}; Path=/oauth; HttpOnly; SameSite=Lax; Max-Age=900${r.conn.encrypted ? '; Secure' : ''}`,
    },
  )
}

// The consent form is signed for this session and this very request (client, return, challenge).
const consentKey = (who: Principal, a: AuthzRequest) =>
  `consent:${who.credential.id}:${a.client.clientId}:${a.redirectUri}:${a.challenge}`

async function consentPage(
  r: PublicReq,
  who: Principal,
  a: AuthzRequest,
  q: Record<string, string>,
  message?: string,
): Promise<Reply> {
  const brains = await consentBrains(r.db, who.accountId)
  const shown = hostOf(a.redirectUri)
  const list = brains.length
    ? brains
        .map(
          (b) =>
            `<label class="opt"><input type="checkbox" name="brain_${esc(b.id)}" value="on"> <span><strong>${esc(b.name)}</strong> <span class="muted">${esc(b.slug)} · you are ${esc(b.role)}</span></span></label>`,
        )
        .join('')
    : '<p class="muted">You are not a member of any brain yet.</p>'
  return page(
    'Connect an app',
    `<h1>Connect “${esc(a.client.name)}”?</h1>
<div class="warn">This name is declared by the app, not verified. After you approve, you go back to <span class="domain">${esc(shown)}</span>. Approve only if you started this from that app.</div>
${message ? `<p class="error" role="alert">${esc(message)}</p>` : ''}
<p>It asks to read your brains${a.scope?.includes('write') ? ' and to write to them' : ''}. It never does more than your role in each brain allows.</p>
<form method="post" action="/oauth/authorize">${hidden(q)}
<input type="hidden" name="csrf" value="${sign(r, consentKey(who, a))}">
<fieldset><legend>Brains it can reach</legend>${list}</fieldset>
<fieldset><legend>Permission</legend>
<label class="opt"><input type="radio" name="perm" value="read" checked> Read</label>
<label class="opt"><input type="radio" name="perm" value="write"> Read and write (the journal, and proposals to the wiki)</label></fieldset>
<p class="muted">Signed in as ${esc(who.name)}. You can end this connection any time in your profile, under “Connected apps”.</p>
<div class="row"><button type="submit" name="decision" value="deny">Deny</button><button class="primary" type="submit" name="decision" value="approve"${brains.length ? '' : ' disabled'}>Approve</button></div></form>`,
  )
}

// Step one of the authorize page, shared by GET and POST: who the client is and where it goes back.
async function authorize(r: PublicReq, q: Record<string, string>) {
  const base = await checkClientAndReturn(r.db, r.clock, q, r.fetchPolicy)
  const iss = await issuer(r.db)
  try {
    return { a: await checkRequest(r.db, q, base), iss }
  } catch (err) {
    if (!(err instanceof OAuthError)) throw err
    return {
      reply: back(base.redirectUri, {
        error: err.error,
        error_description: err.description,
        state: typeof q.state === 'string' ? q.state : null,
        iss,
      }),
    }
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Reply => ({
  status,
  body,
  headers: { 'access-control-allow-origin': '*', ...headers },
})

const oauthError = (err: unknown): Reply => {
  if (err instanceof OAuthError)
    return json(err.status, { error: err.error, error_description: err.description })
  if (err instanceof AppError && err.status < 500)
    return json(400, { error: 'invalid_request', error_description: err.message })
  throw err
}

export const oauthRoutes: Route[] = [
  publicRoute('GET /.well-known/oauth-protected-resource', async (r) => protectedResource(r)),
  publicRoute('GET /.well-known/oauth-protected-resource/mcp', async (r) => protectedResource(r)),
  publicRoute('GET /.well-known/oauth-authorization-server', async (r) => {
    const iss = await issuer(r.db)
    return json(200, {
      issuer: iss,
      authorization_endpoint: `${iss}/oauth/authorize`,
      token_endpoint: `${iss}/oauth/token`,
      registration_endpoint: `${iss}/oauth/register`,
      revocation_endpoint: `${iss}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['brain:read', 'brain:write'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    })
  }),
  publicRoute('POST /oauth/register', async (r) => {
    try {
      return json(201, await registerClient(r.db, r.clock, obj(r.body)))
    } catch (err) {
      return oauthError(err)
    }
  }),
  publicRoute('GET /oauth/authorize', async (r) => {
    let q: Record<string, string>
    let step: Awaited<ReturnType<typeof authorize>>
    try {
      q = queryOf(r.query)
      step = await authorize(r, q)
    } catch (err) {
      if (err instanceof OAuthError) return errorPage(err.description)
      throw err
    }
    if (step.reply) return step.reply
    const who = await personOf(r)
    if (!who) return loginPage(r, q, step.a.client.name)
    return consentPage(r, who, step.a, q)
  }),
  publicRoute('POST /oauth/login', async (r) => {
    const b = obj(r.body) as Record<string, unknown>
    const text = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '')
    let q: Record<string, string>
    let step: Awaited<ReturnType<typeof authorize>>
    try {
      q = queryOf(new URLSearchParams(text('continue')))
      step = await authorize(r, q)
    } catch (err) {
      if (err instanceof OAuthError) return errorPage(err.description)
      throw err
    }
    if (step.reply) return step.reply
    const formNonce = /(?:^|;\s*)rscb_form=([A-Za-z0-9_-]+)/.exec(String(r.headers.cookie ?? ''))?.[1] ?? ''
    if (!formNonce || formNonce !== text('nonce') || !sameText(text('csrf'), sign(r, `login:${formNonce}`))) {
      return loginPage(r, q, step.a.client.name, 'This form expired. Sign in again.', 403)
    }
    try {
      const s = await signIn(r.db, r.clock, r.conn, r.secret, {
        email: text('email'),
        password: text('password'),
        ...(text('code') ? { code: text('code') } : {}),
      })
      return {
        status: 303,
        body: '',
        headers: {
          location: `/oauth/authorize?${new URLSearchParams(q).toString()}`,
          'content-type': 'text/plain',
          'set-cookie': cookie(s.session, r.conn),
        },
      }
    } catch (err) {
      if (err instanceof AppError && err.status < 500) {
        return loginPage(r, q, step.a.client.name, `${err.message} ${err.howToProceed}`, err.status)
      }
      throw err
    }
  }),
  publicRoute('POST /oauth/authorize', async (r) => {
    const b = obj(r.body) as Record<string, string>
    const q: Record<string, string> = {}
    for (const k of AUTHZ_KEYS) if (typeof b[k] === 'string') q[k] = b[k]
    let step: Awaited<ReturnType<typeof authorize>>
    try {
      step = await authorize(r, q)
    } catch (err) {
      if (err instanceof OAuthError) return errorPage(err.description)
      throw err
    }
    if (step.reply) return step.reply
    const who = await personOf(r)
    if (!who) return errorPage('Your session ended. Start the connection again from the app.', 401)
    const a = step.a
    // The approval must come from this page, in this session: another site cannot make it.
    if (typeof b.csrf !== 'string' || !sameText(b.csrf, sign(r, consentKey(who, a)))) {
      return errorPage('This approval did not come from the consent page. Start again from the app.', 403)
    }
    if (b.decision !== 'approve') {
      return back(a.redirectUri, {
        error: 'access_denied',
        error_description: 'The person denied it.',
        state: a.state,
        iss: step.iss,
      })
    }
    const brainIds = Object.keys(b)
      .filter((k) => k.startsWith('brain_') && b[k] === 'on')
      .map((k) => k.slice(6))
    const perm = b.perm === 'write' ? 'write' : 'read'
    try {
      const code = await issueCode(r.db, r.clock, a, who.accountId, { brainIds, perm })
      return back(a.redirectUri, { code, state: a.state, iss: step.iss })
    } catch (err) {
      if (err instanceof OAuthError) return consentPage(r, who, a, q, err.description)
      throw err
    }
  }),
  publicRoute('POST /oauth/token', async (r) => {
    const b = obj(r.body) as Record<string, unknown>
    try {
      if (b.grant_type === 'authorization_code')
        return json(200, await exchangeCode(r.db, r.clock, b), { pragma: 'no-cache' })
      if (b.grant_type === 'refresh_token')
        return json(200, await refreshGrant(r.db, r.clock, b), { pragma: 'no-cache' })
      throw new OAuthError(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.')
    } catch (err) {
      return oauthError(err)
    }
  }),
  publicRoute('POST /oauth/revoke', async (r) => {
    await revokeByToken(r.db, r.clock, obj(r.body) as Record<string, unknown>)
    return json(200, {})
  }),
]

async function protectedResource(r: PublicReq): Promise<Reply> {
  const iss = await issuer(r.db)
  return json(200, {
    resource: resourceOf(iss),
    authorization_servers: [iss],
    scopes_supported: ['brain:read', 'brain:write'],
    bearer_methods_supported: ['header'],
    resource_name: 'RSC Brain',
  })
}
