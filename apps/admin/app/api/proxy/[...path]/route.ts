import { cookies } from "next/headers";

import { API_URL, SESSION_COOKIE } from "@/lib/server/config";

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
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const search = new URL(request.url).search;
  const target = `${API_URL}/${path.join("/")}${search}`;

  const headers: Record<string, string> = {};
  const contentType = request.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;
  if (token) headers["authorization"] = `Bearer ${token}`;

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: hasBody ? await request.text() : undefined,
  });

  const body = await upstream.text();
  const responseHeaders: Record<string, string> = {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
  };
  return new Response(body, { status: upstream.status, headers: responseHeaders });
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
