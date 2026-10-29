// People and keys (spec B4): invitations, members of a brain, personal tokens, notices, and the
// administration of accounts, service accounts, settings and mail. Managing happens in the web.

import { invalid } from '../../core/errors.ts'
import {
  accountKeys,
  adminBrains,
  createService,
  deleteMail,
  getMail,
  getSettings,
  joinBrain,
  listAccounts,
  newMainKey,
  removeAccount,
  restoreAccount,
  setMail,
  testMail,
  updateAccount,
  updateSettings,
} from '../../domain/admin.ts'
import {
  acceptInvitation,
  invite,
  listInvitations,
  lookInvitation,
  resendInvitation,
  revokeInvitation,
} from '../../domain/invitations.ts'
import { listMembers, removeMember, setMember, setNotify } from '../../domain/members.ts'
import { markNoticesRead, myNotices } from '../../domain/notices.ts'
import { createToken, listTokens, revokeToken } from '../../domain/tokens.ts'
import { bool, obj } from '../input.ts'
import { publicRoute, type Route, route } from '../router.ts'
import { cookie, fromWeb } from './auth.ts'
import { ctxOf } from './brains.ts'

export const peopleRoutes: Route[] = [
  // Invitations.
  route('POST /v1/invitations', async (r) => {
    const b = obj(r.body)
    const invitations = await invite(ctxOf(r), {
      emails: b.emails ?? b.email,
      brains: b.brains,
      isAdmin: b.isAdmin,
      canCreateBrains: b.canCreateBrains,
    })
    return { status: 201, body: { invitations } }
  }),
  route('GET /v1/invitations', async (r) => ({ body: { invitations: await listInvitations(ctxOf(r)) } })),
  route('POST /v1/invitations/:id/resend', async (r) => ({
    body: { invitation: await resendInvitation(ctxOf(r), r.params.id as string) },
  })),
  route('DELETE /v1/invitations/:id', async (r) => {
    await revokeInvitation(ctxOf(r), r.params.id as string)
    return { body: { revoked: r.params.id } }
  }),
  // The invitation page: the token travels in the body, never in an address that logs keep.
  publicRoute('POST /v1/invitations/look', async (r) => ({
    body: { invitation: await lookInvitation(r.db, r.clock, obj(r.body).token) },
  })),
  publicRoute('POST /v1/invitations/accept', async (r) => {
    fromWeb(r)
    const b = obj(r.body)
    const s = await acceptInvitation(r.db, r.clock, r.conn, {
      token: b.token,
      name: b.name,
      password: b.password,
    })
    return { status: 201, body: { account: s.account }, headers: { 'set-cookie': cookie(s.session, r.conn) } }
  }),

  // Members of a brain.
  route('GET /v1/brains/:slug/members', async (r) => ({
    body: await listMembers(ctxOf(r), r.params.slug as string),
  })),
  route('POST /v1/brains/:slug/members', async (r) => {
    const b = obj(r.body)
    return {
      status: 201,
      body: {
        member: await setMember(ctxOf(r), r.params.slug as string, { account: b.account, role: b.role }),
      },
    }
  }),
  route('PUT /v1/brains/:slug/members/:account', async (r) => ({
    body: {
      member: await setMember(ctxOf(r), r.params.slug as string, {
        account: r.params.account,
        role: obj(r.body).role,
      }),
    },
  })),
  route('DELETE /v1/brains/:slug/members/:account', async (r) => {
    await removeMember(ctxOf(r), r.params.slug as string, r.params.account as string)
    return { body: { removed: r.params.account } }
  }),
  route('PUT /v1/brains/:slug/notify', async (r) => {
    const on = bool(obj(r.body), 'notifyProposals')
    if (on === undefined)
      throw invalid('"notifyProposals" is true or false.', 'Send {"notifyProposals": true}.')
    return { body: await setNotify(ctxOf(r), r.params.slug as string, on) }
  }),

  // My tokens and notices.
  route('GET /v1/me/tokens', async (r) => ({ body: { tokens: await listTokens(ctxOf(r)) } })),
  route('POST /v1/me/tokens', async (r) => {
    const b = obj(r.body)
    return {
      status: 201,
      body: await createToken(ctxOf(r), {
        name: b.name,
        perm: b.perm,
        brains: b.brains,
        allBrains: b.allBrains,
        days: b.days,
      }),
    }
  }),
  route('DELETE /v1/me/tokens/:id', async (r) => {
    await revokeToken(ctxOf(r), r.params.id as string)
    return { body: { revoked: r.params.id } }
  }),
  route('GET /v1/me/notices', async (r) => ({ body: await myNotices(ctxOf(r)) })),
  route('POST /v1/me/notices/read', async (r) => ({ body: { read: await markNoticesRead(ctxOf(r)) } })),

  // The administration.
  route('GET /v1/admin/accounts', async (r) => ({ body: { accounts: await listAccounts(ctxOf(r)) } })),
  route('PATCH /v1/admin/accounts/:id', async (r) => {
    const b = obj(r.body)
    return {
      body: {
        account: await updateAccount(ctxOf(r), r.params.id as string, {
          isAdmin: b.isAdmin,
          canCreateBrains: b.canCreateBrains,
          canInvite: b.canInvite,
        }),
      },
    }
  }),
  route('POST /v1/admin/accounts/:id/remove', async (r) => ({
    body: await removeAccount(ctxOf(r), r.params.id as string),
  })),
  route('POST /v1/admin/accounts/:id/restore', async (r) => ({
    body: await restoreAccount(ctxOf(r), r.params.id as string),
  })),
  route('GET /v1/admin/accounts/:id/keys', async (r) => ({
    body: { keys: await accountKeys(ctxOf(r), r.params.id as string) },
  })),
  route('POST /v1/admin/services', async (r) => {
    const b = obj(r.body)
    const s = await createService(ctxOf(r), {
      name: b.name,
      canCreateBrains: b.canCreateBrains,
      canInvite: b.canInvite,
      brains: b.brains,
    })
    return {
      status: 201,
      body: {
        account: { id: s.id },
        key: { id: s.key.id, secret: s.key.secret },
        message: 'Copy the key now: Brain shows it only this once.',
      },
    }
  }),
  route('POST /v1/admin/services/:id/keys', async (r) => {
    const k = await newMainKey(ctxOf(r), r.params.id as string, obj(r.body).name)
    return {
      status: 201,
      body: {
        key: { id: k.id, secret: k.secret },
        message: 'Copy the key now: Brain shows it only this once.',
      },
    }
  }),
  route('GET /v1/admin/brains', async (r) => ({ body: { brains: await adminBrains(ctxOf(r)) } })),
  route('POST /v1/admin/brains/:slug/join', async (r) => ({
    body: await joinBrain(ctxOf(r), r.params.slug as string),
  })),
  route('POST /v1/admin/brains/:slug/curator', async (r) => ({
    body: {
      member: await setMember(ctxOf(r), r.params.slug as string, {
        account: obj(r.body).account,
        role: 'curator',
      }),
    },
  })),
  route('GET /v1/admin/settings', async (r) => ({ body: await getSettings(ctxOf(r)) })),
  route('PUT /v1/admin/settings', async (r) => {
    const b = obj(r.body)
    return { body: await updateSettings(ctxOf(r), { name: b.name, curatorsInvite: b.curatorsInvite }) }
  }),
  route('GET /v1/admin/mail', async (r) => ({ body: await getMail(ctxOf(r)) })),
  route('PUT /v1/admin/mail', async (r) => ({ body: await setMail(ctxOf(r), obj(r.body)) })),
  route('DELETE /v1/admin/mail', async (r) => ({ body: await deleteMail(ctxOf(r)) })),
  route('POST /v1/admin/mail/test', async (r) => ({ body: await testMail(ctxOf(r), obj(r.body).to) })),
]
