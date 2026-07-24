import "server-only";

/** Base URL of the rsc-brain API (server-side only; never exposed to the browser). */
export const API_URL = process.env.API_URL ?? "http://localhost:8000";

/** Name of the httpOnly session cookie holding the console session token (`cks_…`). */
export const SESSION_COOKIE = "rsc_session";
