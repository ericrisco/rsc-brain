export type UiErrorKind =
  | "validation"
  | "session-expired"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "rate-limited"
  | "unavailable"
  | "network"
  | "unexpected";

export type UiErrorMessageKey =
  | "errors.validation"
  | "errors.sessionExpired"
  | "errors.forbidden"
  | "errors.notFound"
  | "errors.conflict"
  | "errors.rateLimited"
  | "errors.unavailable"
  | "errors.network"
  | "errors.unexpected";

export interface UiError {
  kind: UiErrorKind;
  messageKey: UiErrorMessageKey;
  retryAfter?: number;
  traceId?: string;
  fieldErrors?: Record<string, string>;
}

const STATUS_ERRORS: Record<number, Pick<UiError, "kind" | "messageKey">> = {
  400: { kind: "validation", messageKey: "errors.validation" },
  401: { kind: "session-expired", messageKey: "errors.sessionExpired" },
  403: { kind: "forbidden", messageKey: "errors.forbidden" },
  404: { kind: "not-found", messageKey: "errors.notFound" },
  409: { kind: "conflict", messageKey: "errors.conflict" },
  422: { kind: "validation", messageKey: "errors.validation" },
  429: { kind: "rate-limited", messageKey: "errors.rateLimited" },
};

function safeTrace(response: Response, payload: unknown): string | undefined {
  for (const name of ["x-trace-id", "x-request-id", "x-correlation-id"]) {
    const value = response.headers.get(name);
    if (value && value.length <= 160 && /^[A-Za-z0-9._:-]+$/u.test(value)) return value;
  }
  if (payload && typeof payload === "object") {
    const correlation = (payload as { audit_correlation?: unknown }).audit_correlation;
    if (
      (typeof correlation === "number" && Number.isSafeInteger(correlation) && correlation >= 0) ||
      (typeof correlation === "string" && /^\d{1,20}$/u.test(correlation))
    ) {
      return String(correlation);
    }
  }
  return undefined;
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value || !/^\d{1,9}$/u.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

function validationFields(payload: unknown): Record<string, string> | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const detail = (payload as { detail?: unknown }).detail;
  if (!Array.isArray(detail)) return undefined;
  const fields: Record<string, string> = {};
  for (const issue of detail) {
    if (!issue || typeof issue !== "object") continue;
    const { loc, msg } = issue as { loc?: unknown; msg?: unknown };
    if (!Array.isArray(loc) || typeof msg !== "string" || msg.length > 240) continue;
    const field = loc.at(-1);
    if (
      typeof field !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(field) ||
      field === "__proto__" ||
      field === "constructor" ||
      field === "prototype"
    ) {
      continue;
    }
    fields[field] = msg;
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

/** Convert an HTTP outcome into finite UI state; raw backend detail is never presentation copy. */
export function uiErrorFromResponse(response: Response, payload?: unknown): UiError {
  const base =
    STATUS_ERRORS[response.status] ??
    (response.status >= 500
      ? { kind: "unavailable" as const, messageKey: "errors.unavailable" as const }
      : { kind: "unexpected" as const, messageKey: "errors.unexpected" as const });
  const traceId = safeTrace(response, payload);
  const wait = response.status === 429 ? retryAfter(response) : undefined;
  const fieldErrors = response.status === 400 || response.status === 422
    ? validationFields(payload)
    : undefined;
  return {
    ...base,
    ...(wait === undefined ? {} : { retryAfter: wait }),
    ...(traceId ? { traceId } : {}),
    ...(fieldErrors ? { fieldErrors } : {}),
  };
}

export function networkUiError(): UiError {
  return { kind: "network", messageKey: "errors.network" };
}
