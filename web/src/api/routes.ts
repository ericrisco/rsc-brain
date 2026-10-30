// Every operation the web calls, by name. Each one is an operation of v1 (spec B6: the web has no
// private routes; a test checks this table against the pinned list). `public`: it needs no session, so
// a 401 there is an answer to show (a wrong password), not a lost session.
export type Op = { route: string; public?: true }

export const ROUTE_TABLE = {
  branding: { route: 'GET /v1/branding', public: true },
  setupState: { route: 'GET /v1/setup', public: true },
  setup: { route: 'POST /v1/setup', public: true },
  login: { route: 'POST /v1/auth/login', public: true },
  logout: { route: 'POST /v1/auth/logout' },
  resetRequest: { route: 'POST /v1/auth/reset', public: true },
  resetLook: { route: 'POST /v1/auth/reset/look', public: true },
  resetConfirm: { route: 'POST /v1/auth/reset/confirm', public: true },
  inviteLook: { route: 'POST /v1/invitations/look', public: true },
  inviteAccept: { route: 'POST /v1/invitations/accept', public: true },
  me: { route: 'GET /v1/me' },
  brains: { route: 'GET /v1/brains' },
  brain: { route: 'GET /v1/brains/{slug}' },
  search: { route: 'GET /v1/search' },
  connect: { route: 'GET /v1/connect' },
} as const satisfies Record<string, Op>

export type OpName = keyof typeof ROUTE_TABLE
