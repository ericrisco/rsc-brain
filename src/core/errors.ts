// Every refusal says what happened and how to proceed (general constitution P6). The HTTP layer turns
// an AppError into { error: { code, message, howToProceed } } with its status; anything else is a 500
// that reveals nothing.
export type ErrorBody = { code: string; message: string; howToProceed: string }

export class AppError extends Error {
  readonly status: number
  readonly code: string
  readonly howToProceed: string
  constructor(status: number, code: string, message: string, howToProceed: string) {
    super(message)
    this.status = status
    this.code = code
    this.howToProceed = howToProceed
  }
  body(): ErrorBody {
    return { code: this.code, message: this.message, howToProceed: this.howToProceed }
  }
}

// One answer for "does not exist" and "you are not a member": revealing which would leak that a
// brain exists (constitution P4).
export const brainNotFound = () =>
  new AppError(
    404,
    'brain_not_found',
    'No brain with that name is available to you.',
    'Check the name with GET /v1/brains, or ask a curator of that brain to add you.',
  )

export const notFound = (what: string) =>
  new AppError(404, 'not_found', `No ${what} with that id is available to you.`, `Check the ${what} id.`)

export const invalid = (message: string, howToProceed: string) =>
  new AppError(400, 'invalid_request', message, howToProceed)

export const denied = (message: string, howToProceed: string) =>
  new AppError(403, 'forbidden', message, howToProceed)

export const conflict = (code: string, message: string, howToProceed: string) =>
  new AppError(409, code, message, howToProceed)

export const unauthorized = (code: string, message: string, howToProceed: string) =>
  new AppError(401, code, message, howToProceed)
