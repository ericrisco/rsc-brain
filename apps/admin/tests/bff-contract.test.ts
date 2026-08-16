import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "rsc_session" ? { value: "server-session-secret" } : undefined),
  }),
}));

describe("same-origin BFF contract (RED until T010)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
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
      "content-disposition": 'attachment; filename="audit-atlas-20260816.csv"',
      "content-type": "application/problem+json",
      "retry-after": "17",
      "x-correlation-id": "corr_01K2",
      "x-request-id": "req_01K2",
      "x-trace-id": "trace_01K2",
    });

    const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(target).toBe(
      "http://localhost:8000/api/v1/admin/audit/export?project=atlas&denied=true",
    );
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ authorization: "Bearer server-session-secret" });
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
        "/review?source=agent-submission&item=42",
        "/manage/users?status=active",
        "/product-metrics?window=30d",
      ]) {
        if (safe(candidate) !== candidate) failures.push(`rejected allow-listed route: ${candidate}`);
      }
      for (const candidate of [
        "https://attacker.example/collect",
        "//attacker.example/collect",
        "/%2f%2fattacker.example/collect",
        "/\\attacker.example/collect",
        "javascript:alert(1)",
        "/api/proxy/api/v1/me",
        "/login?returnTo=https://attacker.example",
        "/metrics",
      ]) {
        if (safe(candidate) !== "/") failures.push(`accepted unsafe return path: ${candidate}`);
      }
      if (safe(null, "/connections") !== "/connections") {
        failures.push("safe explicit fallback was not preserved");
      }
    }

    expect(failures).toEqual([]);
  });
});
