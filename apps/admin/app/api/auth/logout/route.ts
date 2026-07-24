import { cookies } from "next/headers";

import { API_URL, SESSION_COOKIE } from "@/lib/server/config";

export async function POST(): Promise<Response> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    // Best-effort server-side revocation, then always clear the cookie.
    await fetch(`${API_URL}/api/v1/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => undefined);
  }
  store.delete(SESSION_COOKIE);
  return Response.json({ ok: true });
}
