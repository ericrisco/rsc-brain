import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ComponentType } from "react";

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/lib/i18n/context";

const useProductMetrics = vi.fn();
const useHealth = vi.fn();
const usePats = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/api/hooks", () => ({
  useProductMetrics: (...args: unknown[]) => useProductMetrics(...args),
  useHealth: (...args: unknown[]) => useHealth(...args),
  usePats: (...args: unknown[]) => usePats(...args),
  useMe: () => ({
    data: {
      identity: { id: "user-1", email: "operator@example.invalid", role: "owner" },
      user: { id: "user-1", email: "operator@example.invalid", role: "owner" },
      is_owner: true,
      platform_capabilities: ["platform.project.list_all"],
      memberships: [
        {
          project: "alpha",
          role: "project-admin",
          capabilities: ["knowledge.read", "usage.read"],
          allowed_topics: ["general"],
          can_curate: false,
        },
      ],
      preference_metadata: { theme: "system", locale: "en" },
    },
    isLoading: false,
    isError: false,
  }),
}));

vi.mock("@/components/page-shell", () => ({
  PageShell: ({
    title,
    subtitle,
    children,
  }: {
    title: string;
    subtitle?: string;
    children: (project: string) => React.ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      {subtitle ? <p>{subtitle}</p> : null}
      {children("alpha")}
    </main>
  ),
}));

type PageModule = { default: ComponentType };

async function loadPage(relativePath: string): Promise<PageModule | null> {
  return import(/* @vite-ignore */ pathToFileURL(resolve(process.cwd(), relativePath)).href).catch(
    () => null,
  ) as Promise<PageModule | null>;
}

function renderPage(Page: ComponentType, locale: "en" | "es" = "en") {
  return render(
    <LanguageProvider initialLocale={locale}>
      <Page />
    </LanguageProvider>,
  );
}

const metrics = {
  adoption: {
    recalls: 0,
    active_principals: 12,
    recalls_per_day: [
      { day: "2026-08-14", recalls: 8 },
      { day: "2026-08-15", recalls: 0 },
    ],
  },
  quality: { abstention_rate: 0.08, hunts_answered_pct: 0.75 },
  knowledge: { claims: 1842, disputed: 2, open_gaps: 4 },
  health: {
    extraction_errors: 2,
    recall_p95_ms: null,
    tokens_by_capability: { recall: 12500 },
  },
};

describe("Overview decision surface", () => {
  beforeEach(() => {
    useProductMetrics.mockReset().mockReturnValue({ data: metrics, isLoading: false, isError: false });
    useHealth.mockReset().mockReturnValue({
      data: { database: "ok", pending_approval: 3, ingest_errors: 2 },
      isLoading: false,
      isError: false,
    });
    usePats.mockReset().mockReturnValue({
      data: {
        pats: [
          {
            id: "pat-1",
            name: "Automation",
            project: "alpha",
            created_at: "2026-08-01T00:00:00Z",
            expires_at: null,
            revoked: false,
          },
          {
            id: "pat-2",
            name: "Other project",
            project: "beta",
            created_at: "2026-08-01T00:00:00Z",
            expires_at: null,
            revoked: false,
          },
        ],
      },
      isLoading: false,
      isError: false,
    });
  });

  it("replaces the destination-card menu with one actionable, authoritative posture rail", async () => {
    const loaded = await loadPage("app/(console)/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    renderPage(loaded.default);

    expect(screen.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
    const rail = screen.getByRole("region", { name: "Control plane posture" });
    expect(within(rail).getByRole("heading", { name: "Knowledge" })).toBeVisible();
    expect(within(rail).getByRole("heading", { name: "Operations" })).toBeVisible();
    expect(within(rail).getByRole("heading", { name: "Access" })).toBeVisible();
    expect(within(rail).getByRole("heading", { name: "Budget" })).toBeVisible();
    expect(within(rail).getAllByRole("article")).toHaveLength(4);
    expect(within(rail).getByRole("link", { name: /4 open gaps/i })).toHaveAttribute(
      "href",
      "/knowledge?area=gaps",
    );
    expect(within(rail).getByRole("link", { name: /2 ingest failures/i })).toHaveAttribute(
      "href",
      "/observability?tab=ingest",
    );
    expect(within(rail).getByRole("link", { name: /1 active connection/i })).toHaveAttribute(
      "href",
      "/connections?status=active",
    );
    expect(within(rail).getByRole("link", { name: /12,500 tokens/i })).toHaveAttribute(
      "href",
      "/usage?window=30",
    );

    expect(screen.queryByText("Personal access tokens")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Entity graph →/i })).not.toBeInTheDocument();
    expect(
      screen.queryAllByRole("link").some((link) => link.getAttribute("href") === "/metrics"),
    ).toBe(false);
  });

  it("orders only supported attention signals by operational severity", async () => {
    const loaded = await loadPage("app/(console)/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    renderPage(loaded.default);

    const queue = screen.getByRole("region", { name: "Needs attention" });
    const items = within(queue).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("2 ingest failures"),
      expect.stringContaining("2 disputed claims"),
      expect.stringContaining("3 items awaiting review"),
      expect.stringContaining("4 open gaps"),
    ]);
    expect(within(items[0]!).getByRole("link")).toHaveAttribute(
      "href",
      "/observability?tab=ingest",
    );
    expect(within(items[1]!).getByRole("link")).toHaveAttribute(
      "href",
      "/knowledge?area=disputed",
    );
    expect(within(items[2]!).getByRole("link")).toHaveAttribute(
      "href",
      "/review?status=pending",
    );
    expect(within(queue).queryByText(/budget threshold/i)).not.toBeInTheDocument();
    expect(within(queue).queryByText(/access risk/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Recent activity" })).not.toBeInTheDocument();
    expect(screen.queryByText(/previous period/i)).not.toBeInTheDocument();
  });
});

describe("canonical Product Metrics route", () => {
  beforeEach(() => {
    useProductMetrics.mockReset().mockReturnValue({ data: metrics, isLoading: false, isError: false });
    useHealth.mockReset();
    usePats.mockReset();
  });

  it("owns the web route without colliding with the technical /metrics surface", async () => {
    expect(existsSync(resolve(process.cwd(), "app/(console)/product-metrics/page.tsx"))).toBe(true);
    expect(existsSync(resolve(process.cwd(), "app/(console)/metrics/page.tsx"))).toBe(false);
    expect(readFileSync(resolve(process.cwd(), "lib/api/types.ts"), "utf8")).toContain(
      'ProductMetrics = components["schemas"]["ProductMetricsEnvelope"]',
    );

    const loaded = await loadPage("app/(console)/product-metrics/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    renderPage(loaded.default);

    expect(screen.getByRole("heading", { level: 1, name: "Product metrics" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Window" })).toHaveValue("30");
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "Adoption",
      "Quality",
      "Knowledge",
      "Health",
    ]);
    expect(screen.queryByText(/north star/i)).not.toBeInTheDocument();
  });

  it("preserves zero versus unknown and gives every family an operational drill-down", async () => {
    const loaded = await loadPage("app/(console)/product-metrics/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    renderPage(loaded.default);

    const adoption = screen.getByRole("region", { name: "Adoption" });
    const health = screen.getByRole("region", { name: "Health" });
    expect(within(adoption).getByTestId("metric-recalls")).toHaveTextContent("0");
    expect(within(health).getByTestId("metric-p95")).toHaveTextContent("—");
    expect(within(adoption).getByRole("link", { name: "Explore recalls" })).toHaveAttribute(
      "href",
      "/observability?tab=recalls",
    );
    expect(screen.getByRole("link", { name: "Open review queue" })).toHaveAttribute(
      "href",
      "/review",
    );
    expect(screen.getByRole("link", { name: "Inspect knowledge" })).toHaveAttribute(
      "href",
      "/knowledge",
    );
    expect(within(health).getByRole("link", { name: "Open observability" })).toHaveAttribute(
      "href",
      "/observability",
    );
    expect(screen.getAllByText("How this is measured")).toHaveLength(4);
  });

  it("passes an explicit window to the typed query and keeps ES parity", async () => {
    const loaded = await loadPage("app/(console)/product-metrics/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    const user = userEvent.setup();
    renderPage(loaded.default, "es");

    expect(screen.getByRole("heading", { level: 1, name: "Métricas de producto" })).toBeVisible();
    await user.selectOptions(screen.getByRole("combobox", { name: "Ventana" }), "90");
    expect(useProductMetrics).toHaveBeenLastCalledWith("alpha", 90);
  });
});
