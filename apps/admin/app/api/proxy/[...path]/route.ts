import { cookies } from "next/headers";

import { API_URL, SESSION_COOKIE } from "@/lib/server/config";

const REQUEST_HEADERS = ["accept", "content-type", "idempotency-key"] as const;
const RESPONSE_HEADERS = [
  "content-type",
  "content-disposition",
  "retry-after",
  "x-request-id",
  "x-trace-id",
  "x-correlation-id",
] as const;
const UPSTREAM_TIMEOUT_MS = 15_000;
const NO_STORE_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
  "x-content-type-options": "nosniff",
} as const;
const SAFE_CONTENT_TYPES = /^(?:application\/(?:json|problem\+json|octet-stream)|text\/csv)(?:;|$)/iu;

function localProblem(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: NO_STORE_HEADERS });
}

function isAllowedTarget(path: readonly string[]): boolean {
  if (path.length < 3 || path[0] !== "api" || path[1] !== "v1") return false;
  if (path[2] !== "admin" && path[2] !== "me") return false;
  return path.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !segment.includes("%") &&
      !segment.includes("\\") &&
      !segment.includes("/") &&
      !/[\u0000-\u001f\u007f]/u.test(segment),
  );
}

function upstreamTarget(path: readonly string[], requestUrl: string): string {
  const base = new URL(API_URL.endsWith("/") ? API_URL : `${API_URL}/`);
  const target = new URL(path.map(encodeURIComponent).join("/"), base);
  target.search = new URL(requestUrl).search;
  return target.toString();
}

function requestHeaders(request: Request, token: string): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

function safeOpaqueHeader(value: string): boolean {
  return value.length <= 160 && /^[A-Za-z0-9._:-]+$/u.test(value);
}

function safeDownloadHeader(value: string): boolean {
  return (
    value.length <= 256 &&
    /^attachment;\s*filename="?[-A-Za-z0-9_. ]{1,180}"?$/iu.test(value)
  );
}

function safeResponseHeaders(upstream: Response): Headers {
  const headers = new Headers(NO_STORE_HEADERS);
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (!value) continue;
    if (name === "retry-after" && (!/^\d{1,5}$/u.test(value) || Number(value) > 86_400)) continue;
    if (name === "content-disposition" && !safeDownloadHeader(value)) continue;
    if (name.startsWith("x-") && !safeOpaqueHeader(value)) continue;
    headers.set(name, value);
  }
  const contentType = headers.get("content-type");
  if (!contentType || !SAFE_CONTENT_TYPES.test(contentType)) {
    headers.set("content-type", "application/octet-stream");
  }
  return headers;
}

/**
 * Same-origin server proxy: attaches the httpOnly session cookie as a bearer and forwards the
 * request to the real API. The session token therefore never reaches the browser, and every
 * authenticated console call goes through the typed client → this proxy → the API.
 */
async function handler(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await context.params;
  if (!isAllowedTarget(path)) return localProblem(404, "not_found");

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return localProblem(401, "session_required");

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  try {
    const upstream = await fetch(upstreamTarget(path, request.url), {
      method: request.method,
      headers: requestHeaders(request, token),
      body: hasBody ? await request.text() : undefined,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      return localProblem(502, "invalid_upstream_redirect");
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: safeResponseHeaders(upstream),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    return localProblem(timedOut ? 504 : 502, timedOut ? "upstream_timeout" : "upstream_unavailable");
  }
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
