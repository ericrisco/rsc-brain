import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ComponentType } from "react";

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/lib/i18n/context";

let pathname = "/usage";
let search = "";
const replace = vi.fn();
const useUsage = vi.fn();
const useAudit = vi.fn();
const useEntityGraph = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(search),
  useRouter: () => ({ replace, push: vi.fn() }),
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

vi.mock("@/lib/api/hooks", () => ({
  useUsage: (...args: unknown[]) => useUsage(...args),
  useAudit: (...args: unknown[]) => useAudit(...args),
  useEntityGraph: (...args: unknown[]) => useEntityGraph(...args),
}));

type PageModule = { default: ComponentType };

async function loadPage(relativePath: string): Promise<PageModule | null> {
  return import(/* @vite-ignore */ pathToFileURL(resolve(process.cwd(), relativePath)).href).catch(
    () => null,
  ) as Promise<PageModule | null>;
}

function renderPage(Page: ComponentType) {
  return render(
    <LanguageProvider initialLocale="en">
      <Page />
    </LanguageProvider>,
  );
}

describe("Usage exploration", () => {
  beforeEach(() => {
    pathname = "/usage";
    search = "window=30&capability=all";
    replace.mockReset();
    useUsage.mockReset().mockReturnValue({
      data: {
        usage: [
          { capability: "recall", day: "2026-08-15", tokens: 200, calls: 3 },
          { capability: "extractor", day: "2026-08-16", tokens: 100, calls: 2 },
        ],
        daily_totals: [
          { day: "2026-08-15", tokens: 700, calls: 5 },
          { day: "2026-08-16", tokens: 500, calls: 3 },
        ],
        total_tokens: 1200,
        total_calls: 8,
        window_days: 30,
        project: "alpha",
        capability: null,
      },
      isLoading: false,
      isError: false,
    });
  });

  it("uses server totals, URL-backed filters and honest no-pricing language", async () => {
    const loaded = await loadPage("app/(console)/usage/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    const user = userEvent.setup();
    const { container } = renderPage(loaded.default);

    expect(screen.getByRole("heading", { level: 1, name: "Usage" })).toBeVisible();
    const summary = screen.getByRole("region", { name: "Usage summary" });
    expect(within(summary).getByText("1,200")).toBeVisible();
    expect(within(summary).getByText("8")).toBeVisible();
    expect(within(summary).getByText("Budget not configured")).toBeVisible();
    expect(document.body).not.toHaveTextContent(/cost/i);
    expect(screen.getByRole("combobox", { name: "Window" })).toHaveValue("30");
    expect(screen.getByRole("combobox", { name: "Capability" })).toHaveValue("all");
    expect(screen.getByRole("table", { name: "Usage by capability and day" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Token trend" })).toBeVisible();

    await user.selectOptions(screen.getByRole("combobox", { name: "Window" }), "90");
    expect(replace).toHaveBeenCalledWith("/usage?window=90&capability=all", { scroll: false });
    expect(useUsage).toHaveBeenLastCalledWith("alpha", 30, undefined);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("Audit investigation", () => {
  beforeEach(() => {
    pathname = "/audit";
    search = "action=recall&denied=true&offset=0";
    replace.mockReset();
    useAudit.mockReset().mockReturnValue({
      data: {
        audit: [
          {
            id: "audit-1",
            ts: "2026-08-16T10:00:00Z",
            project_id: "project-alpha",
            user_id: "user-1",
            principal_type: "human",
            principal_id: "user-1",
            on_behalf_of: null,
            trace_id: "trace-1",
            action: "recall",
            tool: "mcp",
            query_hash: "sha256:audit-hash",
            query_text: null,
            duration_ms: 42,
            topics_used: ["general"],
            result_count: 0,
            denied: true,
          },
        ],
        next_offset: 2,
        freshness: "2026-08-16T10:01:00Z",
      },
      isLoading: false,
      isError: false,
    });
  });

  it("serializes applied filters and distinguishes zero from unknown", async () => {
    const loaded = await loadPage("app/(console)/audit/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    const { container } = renderPage(loaded.default);

    expect(screen.getByText("Action: recall")).toBeVisible();
    expect(screen.getByText("Denied only")).toBeVisible();
    const table = screen.getByRole("table", { name: "Audit events" });
    expect(within(table).getByText("sha256:audit-hash")).toBeVisible();
    expect(within(table).getByTestId("audit-result-count")).toHaveTextContent("0");
    expect(useAudit).toHaveBeenLastCalledWith(
      "alpha",
      { action: "recall", denied: true },
      50,
      0,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("opens privacy-safe event evidence and paginates on the server", async () => {
    const loaded = await loadPage("app/(console)/audit/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    const user = userEvent.setup();
    renderPage(loaded.default);

    await user.click(screen.getByRole("button", { name: "Inspect audit event audit-1" }));
    const detail = screen.getByRole("region", { name: "Audit event detail" });
    expect(detail).toHaveTextContent("trace-1");
    expect(detail).toHaveTextContent("general");
    expect(detail).toHaveTextContent("Query text not retained");
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(replace).toHaveBeenCalledWith("/audit?action=recall&denied=true&offset=2", {
      scroll: false,
    });
  });
});

describe("Bounded entity explorer", () => {
  beforeEach(() => {
    pathname = "/graph";
    search = "entity=RSC&offset=0&trail=Root";
    replace.mockReset();
    useEntityGraph.mockReset().mockReturnValue({
      data: {
        center: { id: "entity-rsc", name: "RSC", type: "Organization", anchored: true },
        neighbors: [
          { id: "entity-server", name: "Server", type: "System", anchored: false },
        ],
        edges: [{ source: "entity-rsc", target: "entity-server", type: "owns" }],
        total: 30,
        offset: 0,
        limit: 25,
      },
      isLoading: false,
      isFetching: false,
      isError: false,
    });
  });

  it("makes the bounded, directional table the primary graph view", async () => {
    const loaded = await loadPage("app/(console)/graph/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    const { container } = renderPage(loaded.default);

    const detail = screen.getByRole("region", { name: "Entity details" });
    expect(detail).toHaveTextContent("RSC");
    expect(detail).toHaveTextContent("Organization");
    expect(detail).toHaveTextContent("Anchored identity");
    const table = screen.getByRole("table", { name: "Entity neighborhood" });
    expect(within(table).getByText("Server")).toBeVisible();
    expect(within(table).getByText("owns")).toBeVisible();
    expect(within(table).getByText("Outgoing")).toBeVisible();
    expect(screen.getByText("25 entities per page maximum")).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("preserves a URL history trail while following and paging", async () => {
    const loaded = await loadPage("app/(console)/graph/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    const user = userEvent.setup();
    renderPage(loaded.default);

    await user.click(screen.getByRole("button", { name: "Follow Server" }));
    expect(replace).toHaveBeenCalledWith(
      "/graph?entity=Server&offset=0&trail=Root%2CRSC",
      { scroll: false },
    );
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(replace).toHaveBeenCalledWith("/graph?entity=RSC&offset=25&trail=Root", {
      scroll: false,
    });
  });
});
