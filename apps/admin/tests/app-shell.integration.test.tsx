import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ComponentType, ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/lib/i18n/context";

type SessionEnvelope = {
  identity: { id: string; email: string; role: string };
  user: { id: string; email: string; role: string };
  is_owner: boolean;
  platform_capabilities: string[];
  memberships: Array<{
    project: string;
    role: string;
    capabilities: string[];
    allowed_topics: string[];
    can_curate: boolean;
  }>;
  preference_metadata: { theme: "system" | "light" | "dark"; locale: "en" | "es" };
};

const fullSession: SessionEnvelope = {
  identity: { id: "user-1", email: "operator@example.invalid", role: "owner" },
  user: { id: "user-1", email: "operator@example.invalid", role: "owner" },
  is_owner: true,
  platform_capabilities: [
    "platform.project.create",
    "platform.project.list_all",
    "platform.user.invite",
  ],
  memberships: [
    {
      project: "alpha",
      role: "project-admin",
      capabilities: [
        "project.manage.read",
        "project.config.write",
        "knowledge.read",
        "usage.read",
        "knowledge.review.decide",
        "hunt.manage",
      ],
      allowed_topics: ["general"],
      can_curate: true,
    },
    {
      project: "beta",
      role: "viewer",
      capabilities: ["knowledge.read", "usage.read"],
      allowed_topics: ["general"],
      can_curate: false,
    },
  ],
  preference_metadata: { theme: "system", locale: "en" },
};

let pathname = "/audit";
let search = "denied=true";
const replace = vi.fn();
const push = vi.fn();
const logout = vi.fn();
let meResult: {
  data?: SessionEnvelope;
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
} = { data: fullSession, isLoading: false, isError: false };

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace, push }),
  useSearchParams: () => new URLSearchParams(search),
}));

vi.mock("@/lib/api/hooks", () => ({ useMe: () => meResult }));
vi.mock("@/lib/api/auth", () => ({ logout: () => logout() }));

async function load<T>(relativePath: string): Promise<T | null> {
  const modulePath = pathToFileURL(resolve(process.cwd(), relativePath)).href;
  return (await import(/* @vite-ignore */ modulePath).catch(() => null)) as T | null;
}

function harness(children: ReactNode, client = new QueryClient()) {
  return render(
    <QueryClientProvider client={client}>
      <LanguageProvider initialLocale="en">{children}</LanguageProvider>
    </QueryClientProvider>,
  );
}

describe("route-complete authenticated application shell (RED until T014)", () => {
  beforeEach(() => {
    pathname = "/audit";
    search = "denied=true";
    replace.mockReset();
    push.mockReset();
    logout.mockReset();
    meResult = { data: fullSession, isLoading: false, isError: false };
    window.localStorage.clear();
  });

  it("declares 14 authenticated destinations plus login, grouped by operator decision", async () => {
    expect(existsSync(resolve(process.cwd(), "app/(console)/layout.tsx"))).toBe(true);
    expect(existsSync(resolve(process.cwd(), "app/(public)/layout.tsx"))).toBe(true);
    expect(existsSync(resolve(process.cwd(), "app/(public)/login/page.tsx"))).toBe(true);
    const loaded = await load<{
      AUTH_ROUTE: "/login";
      CONSOLE_NAV_GROUPS: Array<{
        id: string;
        routes: Array<{ href: string; capability?: string; scope: string; template: string }>;
      }>;
    }>("lib/navigation/routes.ts");
    expect(loaded?.CONSOLE_NAV_GROUPS, "lib/navigation/routes.ts must own route inventory").toBeDefined();
    if (!loaded) return;
    expect(loaded.AUTH_ROUTE).toBe("/login");

    expect(loaded.CONSOLE_NAV_GROUPS.map((group) => group.id)).toEqual([
      "overview",
      "knowledge",
      "operations",
      "security",
      "resources",
      "management",
    ]);
    const routes = loaded.CONSOLE_NAV_GROUPS.flatMap((group) => group.routes);
    expect(routes.map((route) => route.href)).toEqual([
      "/",
      "/knowledge",
      "/review",
      "/graph",
      "/observability",
      "/connections",
      "/audit",
      "/usage",
      "/product-metrics",
      "/manage/projects",
      "/manage/users",
      "/manage/topics",
      "/manage/hunting",
      "/manage/skills",
    ]);
    expect(routes).toHaveLength(14);
    expect(new Set([loaded.AUTH_ROUTE, ...routes.map((route) => route.href)]).size).toBe(15);
    expect(routes.map((route) => route.href)).not.toContain("/metrics");
    expect(routes.every((route) => ["overview", "collection", "detail", "work-queue", "exploration"].includes(route.template))).toBe(true);
    expect(routes.find((route) => route.href === "/manage/projects")).toMatchObject({
      scope: "platform",
      capability: "platform.project.list_all",
    });
    expect(routes.find((route) => route.href === "/manage/users")).toMatchObject({
      scope: "project",
      capability: "project.manage.read",
    });
  });

  it("removes the old project frame before cancelling and invalidating scope-bound queries", async () => {
    const loaded = await load<{
      ProjectScopeProvider: ComponentType<{ session: SessionEnvelope; children: ReactNode }>;
      ProjectScopeContent: ComponentType<{ children: ReactNode }>;
      useProjectScope: () => {
        project: string;
        scope: string;
        revision: number;
        status: "ready" | "switching";
        queryKey: (resource: string, filters?: unknown) => readonly unknown[];
        switchProject: (project: string) => Promise<void>;
      };
    }>("lib/scope/project-scope.tsx");
    expect(loaded?.ProjectScopeProvider, "ProjectScopeProvider must exist").toBeTypeOf("function");
    expect(loaded?.ProjectScopeContent, "ProjectScopeContent must isolate scoped frames").toBeTypeOf("function");
    expect(loaded?.useProjectScope, "useProjectScope must exist").toBeTypeOf("function");
    if (!loaded?.ProjectScopeContent) return;
    const scopeModule = loaded;

    let releaseCancel: (() => void) | undefined;
    const cancelGate = new Promise<void>((resolveCancel) => {
      releaseCancel = resolveCancel;
    });
    const queryClient = new QueryClient();
    const cancel = vi.spyOn(queryClient, "cancelQueries").mockReturnValue(cancelGate);
    const remove = vi.spyOn(queryClient, "removeQueries");
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    function Probe() {
      const scope = scopeModule.useProjectScope();
      return (
        <>
          <p>Secret frame for {scope.project}</p>
          <p>{`${scope.status}:${scope.scope}:${scope.revision}`}</p>
          <output>{JSON.stringify(scope.queryKey("audit", { denied: true }))}</output>
          <button type="button" onClick={() => void scope.switchProject("beta")}>
            Switch to beta
          </button>
        </>
      );
    }

    harness(
      <loaded.ProjectScopeProvider session={fullSession}>
        <loaded.ProjectScopeContent>
          <Probe />
        </loaded.ProjectScopeContent>
      </loaded.ProjectScopeProvider>,
      queryClient,
    );
    expect(screen.getByText("Secret frame for alpha")).toBeVisible();
    expect(screen.getByText("ready:alpha:0")).toBeVisible();
    expect(screen.getByText('["scope","user-1","alpha",0,"audit",{"denied":true}]')).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Switch to beta" }));
    expect(screen.queryByText("Secret frame for alpha")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Switching project");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    const cancelPredicate = (cancel.mock.calls[0]?.[0] as {
      predicate?: (query: { queryKey: readonly unknown[] }) => boolean;
    }).predicate;
    expect(cancelPredicate?.({ queryKey: ["audit", "alpha"] })).toBe(true);
    expect(cancelPredicate?.({ queryKey: ["me"] })).toBe(false);

    await act(async () => releaseCancel?.());
    await waitFor(() => expect(screen.getByText("Secret frame for beta")).toBeVisible());
    expect(screen.getByText("ready:beta:1")).toBeVisible();
    expect(screen.getByText('["scope","user-1","beta",1,"audit",{"denied":true}]')).toBeVisible();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    const removePredicate = (remove.mock.calls[0]?.[0] as {
      predicate?: (query: { queryKey: readonly unknown[] }) => boolean;
    }).predicate;
    expect(removePredicate?.({ queryKey: ["audit", "alpha"] })).toBe(true);
    expect(removePredicate?.({ queryKey: ["audit", "beta"] })).toBe(false);
    expect(window.localStorage.getItem("rsc-brain.project.user-1")).toBe("beta");
  });

  it("purges the current project frame when authority narrows without a project switch", async () => {
    const loaded = await load<{
      ProjectScopeProvider: ComponentType<{ session: SessionEnvelope; children: ReactNode }>;
      ProjectScopeContent: ComponentType<{ children: ReactNode }>;
      useProjectScope: () => {
        project: string;
        revision: number;
        status: "ready" | "switching";
        membership?: SessionEnvelope["memberships"][number];
      };
    }>("lib/scope/project-scope.tsx");
    expect(loaded?.ProjectScopeProvider).toBeTypeOf("function");
    if (!loaded) return;

    let releaseCancel: (() => void) | undefined;
    const cancelGate = new Promise<void>((resolveCancel) => {
      releaseCancel = resolveCancel;
    });
    const queryClient = new QueryClient();
    queryClient.setQueryData(["kb", "alpha", "security"], { secret: "old-scope" });
    queryClient.setQueryData(["kb", "beta"], { public: true });
    queryClient.setQueryData(["me"], fullSession);
    const cancel = vi.spyOn(queryClient, "cancelQueries").mockReturnValue(cancelGate);
    const remove = vi.spyOn(queryClient, "removeQueries");

    function Probe() {
      const scope = loaded!.useProjectScope();
      return (
        <>
          <p>{`Private frame ${scope.project}`}</p>
          <p>{`${scope.status}:${scope.revision}:${scope.membership?.allowed_topics.join(",")}`}</p>
        </>
      );
    }

    const renderTree = (session: SessionEnvelope) => (
      <QueryClientProvider client={queryClient}>
        <LanguageProvider initialLocale="en">
          <loaded.ProjectScopeProvider session={session}>
            <loaded.ProjectScopeContent>
              <Probe />
            </loaded.ProjectScopeContent>
          </loaded.ProjectScopeProvider>
        </LanguageProvider>
      </QueryClientProvider>
    );
    const view = render(renderTree(fullSession));
    expect(screen.getByText("ready:0:general")).toBeVisible();

    const narrowedSession: SessionEnvelope = {
      ...fullSession,
      memberships: fullSession.memberships.map((membership) =>
        membership.project === "alpha"
          ? { ...membership, capabilities: ["knowledge.read"], allowed_topics: [] }
          : membership,
      ),
    };
    view.rerender(renderTree(narrowedSession));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Switching project"));
    expect(screen.queryByText("Private frame alpha")).not.toBeInTheDocument();
    const predicate = (cancel.mock.calls[0]?.[0] as {
      predicate?: (query: { queryKey: readonly unknown[] }) => boolean;
    }).predicate;
    expect(predicate?.({ queryKey: ["kb", "alpha", "security"] })).toBe(true);
    expect(predicate?.({ queryKey: ["kb", "beta"] })).toBe(false);
    expect(predicate?.({ queryKey: ["me"] })).toBe(false);
    expect(remove).not.toHaveBeenCalled();

    await act(async () => releaseCancel?.());
    await waitFor(() => expect(screen.getByText("ready:1:")).toBeVisible());
    expect(screen.getByText("Private frame alpha")).toBeVisible();
    expect(queryClient.getQueryData(["kb", "alpha", "security"])).toBeUndefined();
    expect(queryClient.getQueryData(["kb", "beta"])).toEqual({ public: true });
    expect(queryClient.getQueryData(["me"])).toEqual(fullSession);
  });

  it("renders a stable auth state and returns expired sessions only to a safe local route", async () => {
    const loaded = await load<{
      AuthBoundary: ComponentType<{ children: ReactNode }>;
    }>("components/auth-boundary.tsx");
    expect(loaded?.AuthBoundary, "AuthBoundary must exist").toBeTypeOf("function");
    if (!loaded) return;

    meResult = { isLoading: true, isError: false };
    const view = harness(
      <loaded.AuthBoundary>
        <p>Private route</p>
      </loaded.AuthBoundary>,
    );
    expect(screen.getByRole("status")).toHaveAccessibleName("Loading console");
    expect(screen.getByTestId("shell-layout").className).toContain("14.5rem");
    expect(screen.getByRole("banner")).toHaveClass("h-14");
    expect(screen.queryByText("Private route")).not.toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();

    meResult = {
      isLoading: false,
      isError: true,
      error: { kind: "session-expired", messageKey: "errors.sessionExpired" },
    };
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <LanguageProvider initialLocale="en">
          <loaded.AuthBoundary>
            <p>Private route</p>
          </loaded.AuthBoundary>
        </LanguageProvider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/login?returnTo=%2Faudit%3Fdenied%3Dtrue"),
    );
    expect(screen.queryByText("Private route")).not.toBeInTheDocument();
  });

  it("keeps a recoverable service error inside the shell instead of misreporting expiry", async () => {
    const loaded = await load<{
      AuthBoundary: ComponentType<{ children: ReactNode }>;
    }>("components/auth-boundary.tsx");
    expect(loaded?.AuthBoundary).toBeTypeOf("function");
    if (!loaded) return;

    meResult = {
      isLoading: false,
      isError: true,
      error: { kind: "network", messageKey: "errors.network", traceId: "trace-42" },
    };
    harness(
      <loaded.AuthBoundary>
        <p>Private route</p>
      </loaded.AuthBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The service could not be reached. Check your connection and retry.",
    );
    expect(screen.getByTestId("shell-layout").className).toContain("14.5rem");
    expect(screen.getByText(/trace-42/)).toBeVisible();
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByText("Private route")).not.toBeInTheDocument();
  });

  it("uses authoritative capabilities for one accessible 232/56 shell and never role strings", async () => {
    const loaded = await load<{
      AppShell: ComponentType<{
        title: string;
        description?: string;
        children: (project: string) => ReactNode;
      }>;
    }>("components/app-shell.tsx");
    expect(loaded?.AppShell, "components/app-shell.tsx must export AppShell").toBeTypeOf("function");
    if (!loaded) return;

    const user = userEvent.setup();
    const queryClient = new QueryClient();
    const clear = vi.spyOn(queryClient, "clear");
    harness(
      <loaded.AppShell title="Audit" description="Operational evidence">
        {(project) => <p>Scoped content for {project}</p>}
      </loaded.AppShell>,
      queryClient,
    );

    expect(screen.getByRole("banner")).toHaveClass("h-14");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(screen.getByRole("heading", { level: 1, name: "Audit" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute(
      "href",
      "#main-content",
    );
    const desktopNavigation = screen.getByTestId("desktop-navigation");
    const links = within(desktopNavigation).getAllByRole("link");
    expect(links).toHaveLength(14);
    expect(within(desktopNavigation).getByRole("link", { name: "Audit log" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(desktopNavigation).queryByRole("link", { name: /metrics/i })).toHaveAttribute(
      "href",
      "/product-metrics",
    );
    expect(screen.getByText("operator@example.invalid")).toBeVisible();
    expect(screen.getByText("Scoped content for alpha")).toBeVisible();
    expect(within(screen.getByRole("combobox", { name: "Project" })).queryByRole("option", { name: "All" })).not.toBeInTheDocument();

    const layout = screen.getByTestId("shell-layout");
    expect(layout).toHaveAttribute("data-rail-state", "expanded");
    expect(layout.className).toContain("14.5rem");
    const railToggle = screen.getByRole("button", { name: "Collapse navigation" });
    await user.click(railToggle);
    expect(layout).toHaveAttribute("data-rail-state", "compact");
    expect(layout.className).toContain("3.5rem");
    expect(window.localStorage.getItem("rsc-brain.rail")).toBe("compact");
    expect(railToggle).toHaveAttribute("aria-expanded", "false");

    await user.click(screen.getByRole("button", { name: "operator@example.invalid" }));
    await user.click(screen.getByRole("menuitem", { name: "Log out" }));
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    expect(clear).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/login");
  });

  it("hides project management destinations when the selected membership lacks capability", async () => {
    const loaded = await load<{
      AppShell: ComponentType<{
        title: string;
        children: (project: string) => ReactNode;
      }>;
    }>("components/app-shell.tsx");
    expect(loaded?.AppShell).toBeTypeOf("function");
    if (!loaded) return;

    const viewerSession: SessionEnvelope = {
      ...fullSession,
      identity: { ...fullSession.identity, role: "member" },
      user: { ...fullSession.user, role: "member" },
      is_owner: false,
      platform_capabilities: [],
      memberships: [
        {
          ...fullSession.memberships[1]!,
          role: "project-admin",
          capabilities: ["knowledge.read", "usage.read"],
        },
      ],
    };
    meResult = { data: viewerSession, isLoading: false, isError: false };
    harness(<loaded.AppShell title="Overview">{() => <p>Viewer frame</p>}</loaded.AppShell>);
    const navigation = screen.getByTestId("desktop-navigation");
    expect(within(navigation).queryByRole("link", { name: /projects/i })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole("link", { name: /users/i })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole("link", { name: /topics/i })).not.toBeInTheDocument();
    expect(within(navigation).getByRole("link", { name: "Living knowledge" })).toBeVisible();
    expect(within(navigation).getByRole("link", { name: "Usage" })).toBeVisible();
  });

  it("denies direct project-management rendering after a capability is revoked", async () => {
    const loaded = await load<{
      AppShell: ComponentType<{
        title: string;
        children: (project: string) => ReactNode;
      }>;
    }>("components/app-shell.tsx");
    expect(loaded?.AppShell).toBeTypeOf("function");
    if (!loaded) return;

    pathname = "/manage/users";
    meResult = {
      data: {
        ...fullSession,
        is_owner: false,
        platform_capabilities: [],
        memberships: [
          {
            ...fullSession.memberships[0]!,
            role: "project-admin",
            capabilities: ["knowledge.read"],
          },
        ],
      },
      isLoading: false,
      isError: false,
    };

    harness(
      <loaded.AppShell title="Users">{() => <p>Private user inventory</p>}</loaded.AppShell>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("You do not have permission");
    expect(screen.queryByText("Private user inventory")).not.toBeInTheDocument();
  });

  it("offers global scope only on an explicit platform route", async () => {
    const loaded = await load<{
      AppShell: ComponentType<{
        title: string;
        children: (project: string) => ReactNode;
      }>;
    }>("components/app-shell.tsx");
    expect(loaded?.AppShell).toBeTypeOf("function");
    if (!loaded) return;

    pathname = "/manage/projects";
    harness(
      <loaded.AppShell title="Projects">
        {(project) => <p>{project === "" ? "Global inventory" : `Project ${project}`}</p>}
      </loaded.AppShell>,
    );
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("");
    expect(screen.getByRole("option", { name: "All" })).toBeVisible();
    expect(screen.getByText("Global inventory")).toBeVisible();
  });

  it("keeps shell geometry mounted while a project switch blocks scoped content", async () => {
    const loaded = await load<{
      AppShell: ComponentType<{
        title: string;
        children: (project: string) => ReactNode;
      }>;
    }>("components/app-shell.tsx");
    expect(loaded?.AppShell).toBeTypeOf("function");
    if (!loaded) return;

    let releaseCancel: (() => void) | undefined;
    const cancelGate = new Promise<void>((resolveCancel) => {
      releaseCancel = resolveCancel;
    });
    const queryClient = new QueryClient();
    vi.spyOn(queryClient, "cancelQueries").mockReturnValue(cancelGate);
    vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    const user = userEvent.setup();
    pathname = "/knowledge";
    harness(
      <loaded.AppShell title="Knowledge">
        {(project) => <p>Confidential knowledge for {project}</p>}
      </loaded.AppShell>,
      queryClient,
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), "beta");

    expect(screen.getByTestId("desktop-navigation")).toBeInTheDocument();
    expect(screen.getByRole("banner")).toHaveClass("h-14");
    expect(screen.queryByText("Confidential knowledge for alpha")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Switching project");

    await act(async () => releaseCancel?.());
    await waitFor(() => expect(screen.getByText("Confidential knowledge for beta")).toBeVisible());
  });
});
