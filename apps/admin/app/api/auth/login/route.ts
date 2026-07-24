import { cookies } from "next/headers";

import { API_URL, SESSION_COOKIE } from "@/lib/server/config";

const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days, matching the API session TTL.

export async function POST(request: Request): Promise<Response> {
  const { email, password } = (await request.json()) as { email?: string; password?: string };
  const upstream = await fetch(`${API_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!upstream.ok) {
    return Response.json({ error: "invalid credentials" }, { status: 401 });
  }
  const { session_token } = (await upstream.json()) as { session_token: string };
  const store = await cookies();
  store.set(SESSION_COOKIE, session_token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return Response.json({ ok: true });
}
