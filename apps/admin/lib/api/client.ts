import createClient from "openapi-fetch";

import type { paths } from "./schema";

/**
 * The single typed API client (golden rule: the console consumes ONLY this).
 *
 * It targets the same-origin Next server proxy (`/api/proxy/...`), which attaches the httpOnly
 * session cookie as a bearer and forwards to the real API — so the browser never holds a token
 * and no view fetches the API directly.
 */
export const api = createClient<paths>({ baseUrl: "/api/proxy" });
