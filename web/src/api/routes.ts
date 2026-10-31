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
  createBrain: { route: 'POST /v1/brains' },
  brain: { route: 'GET /v1/brains/{slug}' },
  overview: { route: 'GET /v1/brains/{slug}/overview' },
  // Followed with EventSource (web/src/live/follow.ts), not through the client; listed so the table
  // still covers every operation the web reaches.
  events: { route: 'GET /v1/brains/{slug}/events' },
  search: { route: 'GET /v1/search' },
  connect: { route: 'GET /v1/connect' },
  invitations: { route: 'GET /v1/invitations' },
  invite: { route: 'POST /v1/invitations' },
  inviteResend: { route: 'POST /v1/invitations/{id}/resend' },
  inviteWithdraw: { route: 'DELETE /v1/invitations/{id}' },
  accounts: { route: 'GET /v1/admin/accounts' },
  resetLink: { route: 'POST /v1/admin/accounts/{id}/reset-link' },
  allBrains: { route: 'GET /v1/admin/brains' },
  createToken: { route: 'POST /v1/me/tokens' },
  // The wiki (PR19).
  wikiMap: { route: 'GET /v1/brains/{slug}/wiki/map' },
  wikiPages: { route: 'GET /v1/brains/{slug}/wiki/pages' },
  wikiDecisions: { route: 'GET /v1/brains/{slug}/wiki/decisions' },
  wikiLog: { route: 'GET /v1/brains/{slug}/wiki/log' },
  page: { route: 'GET /v1/brains/{slug}/pages/{address}' },
  editPage: { route: 'PATCH /v1/brains/{slug}/pages/{address}' },
  wikiChange: { route: 'POST /v1/brains/{slug}/wiki/changes' },
  trail: { route: 'GET /v1/brains/{slug}/trail' },
  entry: { route: 'GET /v1/entries/{id}' },
  // The journal (PR20).
  members: { route: 'GET /v1/brains/{slug}/members' },
  sessions: { route: 'GET /v1/brains/{slug}/sessions' },
  session: { route: 'GET /v1/sessions/{id}' },
  entries: { route: 'GET /v1/brains/{slug}/entries' },
  editEntry: { route: 'PATCH /v1/entries/{id}' },
  forgetEntry: { route: 'POST /v1/entries/{id}/forget' },
  recoverEntry: { route: 'POST /v1/entries/{id}/recover' },
  pinEntry: { route: 'POST /v1/entries/{id}/pin' },
  unpinEntry: { route: 'POST /v1/entries/{id}/unpin' },
  scheduleEntry: { route: 'POST /v1/entries/{id}/schedule' },
  relate: { route: 'POST /v1/brains/{slug}/relations' },
  conflicts: { route: 'GET /v1/brains/{slug}/conflicts' },
  forgotten: { route: 'GET /v1/brains/{slug}/forgotten' },
  toReview: { route: 'GET /v1/brains/{slug}/to-review' },
  addCorrection: { route: 'POST /v1/brains/{slug}/corrections' },
  // The proposals inbox (PR21).
  proposals: { route: 'GET /v1/brains/{slug}/proposals' },
  proposalReview: { route: 'GET /v1/proposals/{id}/review' },
  approveProposal: { route: 'POST /v1/proposals/{id}/approve' },
  returnProposal: { route: 'POST /v1/proposals/{id}/return' },
} as const satisfies Record<string, Op>

export type OpName = keyof typeof ROUTE_TABLE
