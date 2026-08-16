import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
let sessionToken: string | undefined = "server-session-secret";

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "rsc_session" && sessionToken ? { value: sessionToken } : undefined,
  }),
}));

describe("same-origin BFF contract (RED until T010)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    sessionToken = "server-session-secret";
  });

  it("preserves upstream 429 and only the safe retry, trace and download headers", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "rate limited" }), {
        status: 429,
        headers: {
          "content-type": "application/problem+json",
          "retry-after": "17",
          "content-disposition": 'attachment; filename="audit-atlas-20260816.csv"',
          "x-request-id": "req_01K2",
          "x-trace-id": "trace_01K2",
          "x-correlation-id": "corr_01K2",
          "set-cookie": "stolen=1",
          location: "https://attacker.example/collect",
          "x-internal-debug": "database-host",
        },
      }),
    );
    const { GET } = await import("@/app/api/proxy/[...path]/route");
    const response = await GET(
      new Request(
        "http://console.test/api/proxy/api/v1/admin/audit/export?project=atlas&denied=true",
        {
          headers: {
            authorization: "Bearer browser-controlled",
            cookie: "attacker=1",
            "x-forwarded-host": "attacker.example",
          },
        },
      ),
      { params: Promise.resolve({ path: ["api", "v1", "admin", "audit", "export"] }) },
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ detail: "rate limited" });
    expect(Object.fromEntries(response.headers.entries())).toEqual({
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
      "content-disposition": 'attachment; filename="audit-atlas-20260816.csv"',
      "content-type": "application/problem+json",
      "retry-after": "17",
      "x-correlation-id": "corr_01K2",
      "x-request-id": "req_01K2",
      "x-trace-id": "trace_01K2",
      "x-content-type-options": "nosniff",
    });

    const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(target).toBe(
      "http://localhost:8000/api/v1/admin/audit/export?project=atlas&denied=true",
    );
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ authorization: "Bearer server-session-secret" });
    expect(init.redirect).toBe("manual");
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("forwards mutation semantics but never browser authority or hop-by-hop headers", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "stale", audit_correlation: 42 }), {
        status: 409,
        headers: {
          "content-type": "application/json",
          "content-disposition": 'attachment; filename="../../secrets"',
          "retry-after": "999999",
          "x-request-id": "unsafe reflected identifier",
          "x-trace-id": "trace-stale",
          location: "https://attacker.example/redirect",
          "set-cookie": "stolen=1",
          connection: "keep-alive",
        },
      }),
    );
    const { PATCH } = await import("@/app/api/proxy/[...path]/route");
    const body = JSON.stringify({ expected_version: 7, name: "Renamed" });
    const response = await PATCH(
      new Request("http://console.test/api/proxy/api/v1/admin/projects/atlas", {
        method: "PATCH",
        body,
        headers: {
          accept: "application/json",
          authorization: "Bearer browser-controlled",
          connection: "upgrade",
          "content-type": "application/json",
          cookie: "attacker=1",
          "idempotency-key": "rename-atlas-v7",
          "x-forwarded-host": "attacker.example",
          "x-trace-id": "browser-spoof",
        },
      }),
      { params: Promise.resolve({ path: ["api", "v1", "admin", "projects", "atlas"] }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ detail: "stale", audit_correlation: 42 });
    expect(Object.fromEntries(response.headers.entries())).toEqual({
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
      "x-trace-id": "trace-stale",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(target).toBe("http://localhost:8000/api/v1/admin/projects/atlas");
    expect(init).toMatchObject({
      method: "PATCH",
      body,
      cache: "no-store",
      redirect: "manual",
      headers: {
        accept: "application/json",
        authorization: "Bearer server-session-secret",
        "content-type": "application/json",
        "idempotency-key": "rename-atlas-v7",
      },
    });
  });

  it("streams download bytes unchanged and refuses unauthenticated or non-console targets", async () => {
    const binary = new Uint8Array([0, 255, 10, 13, 128, 65]);
    fetchMock.mockResolvedValueOnce(
      new Response(binary, {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="evidence.bin"',
        },
      }),
    );
    const { GET } = await import("@/app/api/proxy/[...path]/route");
    const download = await GET(
      new Request("http://console.test/api/proxy/api/v1/admin/audit/export"),
      { params: Promise.resolve({ path: ["api", "v1", "admin", "audit", "export"] }) },
    );
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(binary);
    expect(Object.fromEntries(download.headers.entries())).toEqual({
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
      "content-disposition": 'attachment; filename="evidence.bin"',
      "content-type": "application/octet-stream",
      "x-content-type-options": "nosniff",
    });

    sessionToken = undefined;
    const missingSession = await GET(
      new Request("http://console.test/api/proxy/api/v1/admin/projects"),
      { params: Promise.resolve({ path: ["api", "v1", "admin", "projects"] }) },
    );
    expect(missingSession.status).toBe(401);
    expect(await missingSession.json()).toEqual({ error: "session_required" });
    expect(missingSession.headers.get("cache-control")).toBe("no-store");

    sessionToken = "server-session-secret";
    for (const path of [
      ["health"],
      ["metrics"],
      ["api", "v1", "oauth", "token"],
      ["api", "v1", "admin", "..", "auth", "login"],
      ["api", "v1", "me", "..", "admin", "projects"],
    ]) {
      const rejected = await GET(new Request(`http://console.test/api/proxy/${path.join("/")}`), {
        params: Promise.resolve({ path }),
      });
      expect(rejected.status).toBe(404);
      expect(rejected.headers.get("cache-control")).toBe("no-store");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("turns upstream redirects and transport failures into finite non-cacheable outcomes", async () => {
    const { GET } = await import("@/app/api/proxy/[...path]/route");
    const invoke = () =>
      GET(new Request("http://console.test/api/proxy/api/v1/me"), {
        params: Promise.resolve({ path: ["api", "v1", "me"] }),
      });

    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://attacker.example" } }),
    );
    const redirected = await invoke();
    expect(redirected.status).toBe(502);
    expect(await redirected.json()).toEqual({ error: "invalid_upstream_redirect" });
    expect(Object.fromEntries(redirected.headers.entries())).toEqual({
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
    });

    fetchMock.mockRejectedValueOnce(new TypeError("internal host must not escape"));
    const unavailable = await invoke();
    expect(unavailable.status).toBe(502);
    expect(await unavailable.json()).toEqual({ error: "upstream_unavailable" });
    expect(JSON.stringify(Object.fromEntries(unavailable.headers.entries()))).not.toContain(
      "internal host",
    );

    fetchMock.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    const timedOut = await invoke();
    expect(timedOut.status).toBe(504);
    expect(await timedOut.json()).toEqual({ error: "upstream_timeout" });
  });

  it("uses an allow-listed local return path and rejects every open-redirect form", async () => {
    const modulePath = pathToFileURL(resolve(process.cwd(), "lib/auth/safe-return.ts")).href;
    const loaded = (await import(/* @vite-ignore */ modulePath).catch(() => null)) as null | {
      safeReturnPath: (candidate: string | null | undefined, fallback?: string) => string;
    };
    const failures: string[] = [];
    if (!loaded?.safeReturnPath) {
      failures.push("lib/auth/safe-return.ts must export safeReturnPath");
    } else {
      const safe = loaded.safeReturnPath;
      for (const candidate of [
        "/",
        "/connections?status=active",
        "/observability?tab=recalls",
        "/knowledge?area=claims",
        "/review?source=agent-submission&item=42",
        "/usage?window=30d",
        "/audit?denied=true",
        "/graph?entity=42",
        "/manage/projects",
        "/manage/users?status=active",
        "/manage/topics",
        "/manage/hunting",
        "/manage/skills",
        "/product-metrics?window=30d",
      ]) {
        if (safe(candidate) !== candidate) failures.push(`rejected allow-listed route: ${candidate}`);
      }
      for (const candidate of [
        "https://attacker.example/collect",
        "//attacker.example/collect",
        "/%2f%2fattacker.example/collect",
        "/%252f%252fattacker.example/collect",
        "/%2e%2e/api/proxy/api/v1/me",
        "/\\attacker.example/collect",
        "/connections\\@attacker.example",
        "javascript:alert(1)",
        "/api/proxy/api/v1/me",
        "/api/auth/logout",
        "/_next/static/chunk.js",
        "/login?returnTo=https://attacker.example",
        "/login",
        "/metrics",
        "/connections-impersonated",
        "/connections?returnTo=https://attacker.example",
        "/manage/users/../../api/proxy/api/v1/me",
        " /connections",
      ]) {
        if (safe(candidate) !== "/") failures.push(`accepted unsafe return path: ${candidate}`);
      }
      if (safe(null, "/connections") !== "/connections") {
        failures.push("safe explicit fallback was not preserved");
      }
      if (safe(null, "https://attacker.example") !== "/") {
        failures.push("unsafe fallback was trusted");
      }
    }

    expect(failures).toEqual([]);
  });

  it("maps transport outcomes to finite localized UI errors without leaking backend detail", async () => {
    const modulePath = pathToFileURL(resolve(process.cwd(), "lib/api/ui-error.ts")).href;
    const loaded = (await import(/* @vite-ignore */ modulePath).catch(() => null)) as null | {
      uiErrorFromResponse: (response: Response, payload?: unknown) => {
        kind: string;
        messageKey: string;
        retryAfter?: number;
        traceId?: string;
        fieldErrors?: Record<string, string>;
      };
      networkUiError: () => { kind: string; messageKey: string };
    };
    expect(loaded?.uiErrorFromResponse).toBeTypeOf("function");
    expect(loaded?.networkUiError).toBeTypeOf("function");
    if (!loaded) return;

    const cases = [
      [400, "validation", "errors.validation"],
      [401, "session-expired", "errors.sessionExpired"],
      [403, "forbidden", "errors.forbidden"],
      [404, "not-found", "errors.notFound"],
      [409, "conflict", "errors.conflict"],
      [429, "rate-limited", "errors.rateLimited"],
      [503, "unavailable", "errors.unavailable"],
    ] as const;
    for (const [status, kind, messageKey] of cases) {
      const error = loaded.uiErrorFromResponse(
        new Response(null, {
          status,
          headers: {
            "retry-after": status === 429 ? "17" : "ignored",
            "x-trace-id": "trace-safe",
          },
        }),
        { detail: "database hostname and query must never reach UI copy" },
      );
      expect(error).toMatchObject({ kind, messageKey, traceId: "trace-safe" });
      expect(JSON.stringify(error)).not.toContain("database hostname");
      if (status === 429) expect(error.retryAfter).toBe(17);
      else expect(error).not.toHaveProperty("retryAfter");
    }
    expect(
      loaded.uiErrorFromResponse(new Response(null, { status: 422 }), {
        detail: [
          { loc: ["body", "email"], msg: "invalid email", type: "value_error" },
          { loc: ["body", "password"], msg: "too short", type: "value_error" },
        ],
      }),
    ).toMatchObject({
      kind: "validation",
      messageKey: "errors.validation",
      fieldErrors: { email: "invalid email", password: "too short" },
    });
    expect(
      loaded.uiErrorFromResponse(new Response(null, { status: 409 }), {
        detail: "stale",
        audit_correlation: 42,
      }),
    ).toMatchObject({ kind: "conflict", messageKey: "errors.conflict", traceId: "42" });
    expect(loaded.networkUiError()).toEqual({
      kind: "network",
      messageKey: "errors.network",
    });
  });
});
