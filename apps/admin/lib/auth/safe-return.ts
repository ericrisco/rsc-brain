const RETURN_PATHS = new Map<string, ReadonlySet<string>>([
  ["/", new Set()],
  ["/connections", new Set(["status"])],
  ["/observability", new Set(["tab", "principal_type", "denied"])],
  ["/knowledge", new Set(["area", "audience", "status"])],
  ["/review", new Set(["source", "item", "status"])],
  ["/usage", new Set(["window", "days", "capability"])],
  [
    "/audit",
    new Set(["action", "tool", "principal_type", "principal_id", "denied", "since", "until"]),
  ],
  ["/product-metrics", new Set(["window"])],
  ["/graph", new Set(["entity", "offset", "limit"])],
  ["/manage/projects", new Set(["status"])],
  ["/manage/users", new Set(["status"])],
  ["/manage/topics", new Set(["status"])],
  ["/manage/hunting", new Set(["status", "topic"])],
  ["/manage/skills", new Set(["status", "stale"])],
]);

function accepted(candidate: string | null | undefined): string | null {
  if (!candidate || candidate !== candidate.trim()) return null;
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return null;
  if (candidate.includes("\\") || candidate.includes("#")) return null;
  if (/[\u0000-\u001f\u007f]/u.test(candidate)) return null;

  const queryIndex = candidate.indexOf("?");
  const rawPath = queryIndex === -1 ? candidate : candidate.slice(0, queryIndex);
  const allowedParams = RETURN_PATHS.get(rawPath);
  if (rawPath.includes("%") || !allowedParams || candidate.length > 2048) return null;

  try {
    const parsed = new URL(candidate, "https://console.invalid");
    if (parsed.origin !== "https://console.invalid" || parsed.pathname !== rawPath) return null;
    for (const [name, value] of parsed.searchParams) {
      if (!allowedParams.has(name) || value.length > 256) return null;
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

/** Return a known console destination only; unsafe candidates and fallbacks collapse to `/`. */
export function safeReturnPath(
  candidate: string | null | undefined,
  fallback = "/",
): string {
  return accepted(candidate) ?? accepted(fallback) ?? "/";
}
