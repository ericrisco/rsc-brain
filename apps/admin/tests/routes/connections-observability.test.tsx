import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ComponentType } from "react";

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/lib/i18n/context";

let pathname = "/connections";
let search = "";
const replace = vi.fn();
const createPat = vi.fn();
const revokePat = vi.fn();
const approveDoc = vi.fn();
const rejectDoc = vi.fn();
const useActivity = vi.fn();
const useHealth = vi.fn();
const useRecalls = vi.fn();
const useIngest = vi.fn();
const usePendingDocs = vi.fn();

const session = {
  identity: { id: "user-1", email: "operator@example.invalid", role: "member" },
  user: { id: "user-1", email: "operator@example.invalid", role: "member" },
  is_owner: false,
  platform_capabilities: [],
  memberships: [
    {
      project: "alpha",
      role: "project-admin",
      capabilities: ["knowledge.read", "document.decide"],
      allowed_topics: ["general"],
      can_curate: false,
    },
  ],
  preference_metadata: { theme: "system", locale: "en" },
};

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
  useMe: () => ({ data: session, isLoading: false, isError: false }),
  usePats: () => ({
    data: {
      pats: [
        {
          id: "pat-1",
          name: "Build agent",
          project: "alpha",
          created_at: "2026-08-01T10:00:00Z",
          expires_at: null,
          revoked: false,
        },
      ],
    },
    isLoading: false,
    isError: false,
  }),
  useCreatePat: () => ({ mutateAsync: createPat, isPending: false }),
  useRevokePat: () => ({ mutateAsync: revokePat, mutate: revokePat, isPending: false }),
  useActivity: (...args: unknown[]) => useActivity(...args),
  useHealth: (...args: unknown[]) => useHealth(...args),
  useRecalls: (...args: unknown[]) => useRecalls(...args),
  useIngest: (...args: unknown[]) => useIngest(...args),
  usePendingDocs: (...args: unknown[]) => usePendingDocs(...args),
  useApproveDoc: () => ({ mutateAsync: approveDoc, mutate: approveDoc, isPending: false }),
  useRejectDoc: () => ({ mutateAsync: rejectDoc, mutate: rejectDoc, isPending: false }),
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

describe("Connections access control center", () => {
  beforeEach(() => {
    pathname = "/connections";
    search = "";
    replace.mockReset();
    createPat.mockReset().mockResolvedValue({ pat_id: "pat-new", token: "pat_secret_once_42" });
    revokePat.mockReset().mockResolvedValue({ ok: true, revoked: "pat-1" });
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("uses the shared shell, access posture and an inspectable credential inventory", async () => {
    const loaded = await loadPage("app/(console)/connections/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    renderPage(loaded.default);

    expect(screen.getByRole("heading", { level: 1, name: "My connections" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Access posture" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Create credential" })).toBeVisible();
    const table = screen.getByRole("table", { name: "Personal access tokens" });
    expect(within(table).getByText("Build agent")).toBeVisible();
    expect(within(table).getByText("alpha")).toBeVisible();
    expect(within(table).getByText("Active")).toBeVisible();
    expect(screen.getByText("Not available in this release")).toBeVisible();
    expect(screen.queryByText("Available in v0.2")).not.toBeInTheDocument();
  });

  it("keeps a newly issued secret in one ephemeral, explicitly acknowledged region", async () => {
    const loaded = await loadPage("app/(console)/connections/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    const user = userEvent.setup();
    renderPage(loaded.default);

    await user.click(screen.getByRole("button", { name: "Create credential" }));
    const dialog = screen.getByRole("dialog", { name: "Create personal access token" });
    expect(within(dialog).getByText(/alpha/)).toBeVisible();
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "CLI laptop");
    await user.click(within(dialog).getByRole("button", { name: "Create token" }));

    expect(createPat).toHaveBeenCalledWith({ project: "alpha", name: "CLI laptop" });
    const secret = await screen.findByRole("region", { name: "New credential secret" });
    expect(within(secret).getByText("pat_secret_once_42")).toBeVisible();
    expect(within(secret).getByRole("button", { name: "Copy secret" })).toBeVisible();
    expect(JSON.stringify(window.localStorage)).not.toContain("pat_secret_once_42");
    expect(JSON.stringify(window.sessionStorage)).not.toContain("pat_secret_once_42");
    expect(window.location.href).not.toContain("pat_secret_once_42");

    await user.click(within(secret).getByRole("button", { name: "I stored it" }));
    expect(screen.queryByText("pat_secret_once_42")).not.toBeInTheDocument();
  });

  it("restates credential, project and immediate effect before revoke", async () => {
    const loaded = await loadPage("app/(console)/connections/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    const user = userEvent.setup();
    renderPage(loaded.default);

    await user.click(screen.getByRole("button", { name: "Revoke Build agent" }));
    const dialog = screen.getByRole("dialog", { name: "Revoke credential" });
    expect(dialog).toHaveTextContent("Build agent");
    expect(dialog).toHaveTextContent("alpha");
    expect(dialog).toHaveTextContent("stops working immediately");
    await user.click(within(dialog).getByRole("button", { name: "Revoke now" }));
    await waitFor(() => expect(revokePat).toHaveBeenCalledWith("pat-1"));
  });
});

describe("Observability operational workspace", () => {
  beforeEach(() => {
    pathname = "/observability";
    search = "tab=overview";
    session.memberships[0]!.role = "project-admin";
    replace.mockReset();
    approveDoc.mockReset();
    rejectDoc.mockReset();
    useActivity.mockReset().mockReturnValue({
      data: { recalls: 18, denied: 2, active_principals: 4, p95_duration_ms: 82, recalls_per_day: [] },
      isLoading: false,
      isError: false,
    });
    useHealth.mockReset().mockReturnValue({
      data: { database: "ok", pending_approval: 1, ingest_errors: 1 },
      isLoading: false,
      isError: false,
    });
    useRecalls.mockReset().mockReturnValue({
      data: {
        items: [
          {
            id: "recall-1",
            ts: "2026-08-16T10:00:00Z",
            principal_type: "human",
            principal_id: "user-1",
            on_behalf_of: null,
            query_text: null,
            query_hash: "sha256:visible-hash",
            topics_used: ["general"],
            result_count: 0,
            duration_ms: null,
            denied: false,
          },
        ],
        next_cursor: null,
        total: 1,
        freshness: "2026-08-16T10:00:00Z",
      },
      isLoading: false,
      isError: false,
    });
    useIngest.mockReset().mockReturnValue({
      data: {
        runs: [{ document_id: "doc-1", phase: "extract", completed_stages: ["parse"], chunks_created: 4, claims_generated: 0, discarded_chunks: 0, error: null }],
        errors: [{ document_id: "doc-1", stage: "extract", error: "bounded failure" }],
      },
      isLoading: false,
      isError: false,
    });
    usePendingDocs.mockReset().mockReturnValue({
      data: { documents: [{ document_id: "doc-1", title: "Runbook", proposed_tags: ["general"], source_id: "source-1", preview: "Safe preview" }] },
      isLoading: false,
      isError: false,
    });
  });

  it("exposes four URL-backed tabs and a visible polling pause", async () => {
    const loaded = await loadPage("app/(console)/observability/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    const user = userEvent.setup();
    renderPage(loaded.default);

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Recalls",
      "Ingest",
      "Approvals 1",
    ]);
    await user.click(screen.getByRole("button", { name: "Pause auto-refresh" }));
    expect(screen.getByRole("button", { name: "Resume auto-refresh" })).toBeVisible();
    expect(useActivity).toHaveBeenLastCalledWith("alpha", { paused: true });
    await user.click(screen.getByRole("tab", { name: "Recalls" }));
    expect(replace).toHaveBeenCalledWith("/observability?tab=recalls", { scroll: false });
  });

  it("does not expose the approval surface outside project administration", async () => {
    session.memberships[0]!.role = "viewer";
    search = "tab=approvals";
    const loaded = await loadPage("app/(console)/observability/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    renderPage(loaded.default);

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Recalls",
      "Ingest",
    ]);
    expect(screen.queryByRole("tab", { name: /Approvals/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Operational signal" })).toBeVisible();
    expect(usePendingDocs).toHaveBeenLastCalledWith("alpha", {
      paused: false,
      enabled: false,
    });
  });

  it("renders privacy-safe recall unknowns without resurrecting query text", async () => {
    search = "tab=recalls";
    const loaded = await loadPage("app/(console)/observability/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    renderPage(loaded.default);

    const table = screen.getByRole("table", { name: "Recall stream" });
    expect(within(table).getByText("sha256:visible-hash")).toBeVisible();
    expect(within(table).getByTestId("recall-result-count")).toHaveTextContent("0");
    expect(within(table).getByTestId("recall-duration")).toHaveTextContent("—");
    expect(document.body).not.toHaveTextContent("raw secret question");
  });

  it("supports both approval decisions and editable tags", async () => {
    search = "tab=approvals";
    const loaded = await loadPage("app/(console)/observability/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    const user = userEvent.setup();
    renderPage(loaded.default);

    const tags = screen.getByRole("textbox", { name: "Proposed tags" });
    await user.clear(tags);
    await user.type(tags, "general, runbook");
    await user.click(screen.getByRole("button", { name: "Approve Runbook" }));
    expect(approveDoc).toHaveBeenCalledWith({ documentId: "doc-1", tags: ["general", "runbook"] });

    await user.click(screen.getByRole("button", { name: "Reject Runbook" }));
    const dialog = screen.getByRole("dialog", { name: "Reject document" });
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "Wrong source");
    await user.click(within(dialog).getByRole("button", { name: "Reject document" }));
    expect(rejectDoc).toHaveBeenCalledWith({ documentId: "doc-1", reason: "Wrong source" });
  });
});
