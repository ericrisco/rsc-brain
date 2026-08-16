import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ComponentType } from "react";

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/lib/i18n/context";

let pathname = "/manage/projects";
let search = "";
const replace = vi.fn();
const createProject = vi.fn();
const deleteProject = vi.fn();
const inviteUser = vi.fn();
const disableUser = vi.fn();
const createCredential = vi.fn();
const createTopic = vi.fn();
const updateTopic = vi.fn();
const grantTopic = vi.fn();
const revokeTopic = vi.fn();
const askHunt = vi.fn();
const createSkill = vi.fn();
const validateSkill = vi.fn();
const archiveSkill = vi.fn();
const useHunts = vi.fn();

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
  useProjects: () => ({
    data: {
      projects: [
        { id: "project-default", slug: "default", name: "Default", settings: {}, status: "active", version: 2, membership_count: 1 },
        { id: "project-alpha", slug: "alpha", name: "Alpha", settings: { query_text_logging: false }, status: "active", version: 4, membership_count: 3 },
      ],
    },
    isLoading: false,
    isError: false,
  }),
  useCreateProject: () => ({ mutateAsync: createProject, isPending: false }),
  useUpdateProject: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useProjectDeleteImpact: () => ({
    data: {
      project: { id: "project-alpha", slug: "alpha", name: "Alpha", settings: {}, status: "active", version: 4 },
      version: 4,
      can_delete: true,
      confirmation: "delete alpha",
      dependencies: { memberships: 3, documents: 12, claims: 48 },
    },
    isLoading: false,
    isError: false,
  }),
  useDeleteProject: () => ({ mutateAsync: deleteProject, isPending: false }),
  useUsers: () => ({
    data: {
      items: [
        { id: "user-ada", email: "ada@example.invalid", role: "project-admin", status: "active", version: 6, allowed_topics: ["general", "security"], can_curate: true },
      ],
      next_cursor: null,
    },
    isLoading: false,
    isError: false,
  }),
  useInviteUser: () => ({ mutateAsync: inviteUser, isPending: false }),
  useDisableUser: () => ({ mutateAsync: disableUser, isPending: false }),
  useUserCredentials: () => ({
    data: { items: [{ id: "cred-1", user_id: "user-ada", project: "alpha", name: "Automation", kind: "pat", status: "active", version: 2 }] },
    isLoading: false,
    isError: false,
  }),
  useCreateUserCredential: () => ({ mutateAsync: createCredential, isPending: false }),
  useRotateUserCredential: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRevokeUserCredential: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateMembership: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTopics: () => ({
    data: { topics: [{ id: "topic-security", slug: "security", name: "Security", sensitivity: 3, hard_window_days: 30, status: "active", version: 5 }] },
    isLoading: false,
    isError: false,
  }),
  useCreateTopic: () => ({ mutateAsync: createTopic, isPending: false }),
  useUpdateTopic: () => ({ mutateAsync: updateTopic, isPending: false }),
  useGrantTopic: () => ({ mutateAsync: grantTopic, isPending: false }),
  useRevokeTopic: () => ({ mutateAsync: revokeTopic, isPending: false }),
  useHunts: (...args: unknown[]) => useHunts(...args),
  useAskHunt: () => ({ mutateAsync: askHunt, isPending: false }),
  useSkills: () => ({
    data: {
      skills: [
        { slug: "rotate-keys", title: "Rotate keys", status: "proposed", stale: true, depends_on: ["entity-1"], version: 7 },
      ],
    },
    isLoading: false,
    isError: false,
  }),
  useCreateSkill: () => ({ mutateAsync: createSkill, isPending: false }),
  useValidateSkill: () => ({ mutateAsync: validateSkill, isPending: false }),
  useArchiveSkill: () => ({ mutateAsync: archiveSkill, isPending: false }),
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

describe("Platform project governance", () => {
  beforeEach(() => {
    pathname = "/manage/projects";
    search = "";
    replace.mockReset();
    createProject.mockReset().mockResolvedValue({ project: { slug: "beta" }, replayed: false });
    deleteProject.mockReset().mockResolvedValue({ project: "alpha", status: "deleted" });
  });

  it("shows a platform-scoped inventory and creates an intentional project", async () => {
    const loaded = await loadPage("app/(console)/manage/projects/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    const user = userEvent.setup();
    renderPage(loaded.default);

    expect(screen.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Platform project inventory" })).toHaveTextContent("Platform scope");
    const table = screen.getByRole("table", { name: "Projects across this instance" });
    expect(within(table).getByText("Alpha")).toBeVisible();
    expect(within(table).getByText("3")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Create project" }));
    const dialog = screen.getByRole("dialog", { name: "Create project" });
    await user.type(within(dialog).getByRole("textbox", { name: "Slug" }), "beta");
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Beta");
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(createProject).toHaveBeenCalledWith({ slug: "beta", name: "Beta", settings: {} }));
  });

  it("requires server impact and exact confirmation before destructive deletion", async () => {
    const loaded = await loadPage("app/(console)/manage/projects/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    const user = userEvent.setup();
    renderPage(loaded.default);

    await user.click(screen.getByRole("button", { name: "Delete Alpha" }));
    const dialog = screen.getByRole("dialog", { name: "Delete project" });
    expect(dialog).toHaveTextContent("12 documents");
    expect(dialog).toHaveTextContent("48 claims");
    const confirm = within(dialog).getByRole("textbox", { name: "Type delete alpha to confirm" });
    expect(within(dialog).getByRole("button", { name: "Delete project now" })).toBeDisabled();
    await user.type(confirm, "delete alpha");
    await user.click(within(dialog).getByRole("button", { name: "Delete project now" }));
    await waitFor(() => expect(deleteProject).toHaveBeenCalledWith({ slug: "alpha", expectedVersion: 4, confirm: "delete alpha" }));
  });
});

describe("Project identity administration", () => {
  beforeEach(() => {
    pathname = "/manage/users";
    search = "";
    inviteUser.mockReset().mockResolvedValue({ invitation_token: "invite_once_42" });
    disableUser.mockReset();
    createCredential.mockReset().mockResolvedValue({ secret: "pat_once_42", credential: { id: "cred-2" } });
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("combines identity, project authority and credentials without persisting secrets", async () => {
    const loaded = await loadPage("app/(console)/manage/users/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    const user = userEvent.setup();
    renderPage(loaded.default);

    expect(screen.getByRole("region", { name: "Access administration" })).toHaveTextContent("alpha");
    const table = screen.getByRole("table", { name: "User directory" });
    expect(within(table).getByText("ada@example.invalid")).toBeVisible();
    expect(within(table).getByText("project-admin")).toBeVisible();
    await user.click(within(table).getByRole("button", { name: "Manage ada@example.invalid" }));
    const detail = screen.getByRole("region", { name: "User access details" });
    expect(detail).toHaveTextContent("general, security");
    expect(within(detail).getByText("Automation")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Invite user" }));
    const invite = screen.getByRole("dialog", { name: "Invite user" });
    await user.type(within(invite).getByRole("textbox", { name: "Email" }), "grace@example.invalid");
    await user.click(within(invite).getByRole("button", { name: "Create invitation" }));
    expect(inviteUser).toHaveBeenCalledWith({ email: "grace@example.invalid", projectRole: "member", platformRole: "member", allowedTopics: [], canCurate: false });
    const secret = await screen.findByRole("region", { name: "Invitation secret" });
    expect(secret).toHaveTextContent("invite_once_42");
    expect(JSON.stringify(window.localStorage)).not.toContain("invite_once_42");
    expect(JSON.stringify(window.sessionStorage)).not.toContain("invite_once_42");
  });
});

describe("Authorization topic governance", () => {
  beforeEach(() => {
    pathname = "/manage/topics";
    search = "";
    createTopic.mockReset();
    updateTopic.mockReset();
    grantTopic.mockReset();
    revokeTopic.mockReset();
  });

  it("makes sensitivity and hard-retention semantics explicit when creating a topic", async () => {
    const loaded = await loadPage("app/(console)/manage/topics/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    const user = userEvent.setup();
    renderPage(loaded.default);

    expect(screen.getByRole("heading", { level: 1, name: "Topics" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Authorization boundary" })).toHaveTextContent("retrieval and administration");
    const table = screen.getByRole("table", { name: "Authorization topics" });
    expect(within(table).getByText("3 / 10")).toBeVisible();
    expect(within(table).getByText("30 days")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Create topic" }));
    const dialog = screen.getByRole("dialog", { name: "Create topic" });
    await user.type(within(dialog).getByRole("textbox", { name: "Slug" }), "legal");
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Legal");
    await user.clear(within(dialog).getByRole("spinbutton", { name: "Sensitivity" }));
    await user.type(within(dialog).getByRole("spinbutton", { name: "Sensitivity" }), "4");
    await user.clear(within(dialog).getByRole("spinbutton", { name: "Hard retention (days)" }));
    await user.type(within(dialog).getByRole("spinbutton", { name: "Hard retention (days)" }), "90");
    await user.click(within(dialog).getByRole("button", { name: "Create topic" }));
    await waitFor(() => expect(createTopic).toHaveBeenCalledWith({ slug: "legal", name: "Legal", sensitivity: 4, hardWindowDays: 90 }));
  });
});

describe("Human hunting operations", () => {
  beforeEach(() => {
    pathname = "/manage/hunting";
    search = "open=true";
    replace.mockReset();
    askHunt.mockReset();
    useHunts.mockReset().mockReturnValue({
      data: { hunts: [{ id: "hunt-1", type: "GAP", state: "ASKED", question: "Who owns key rotation?", topics: ["security"], person_id: "person-1", gap_id: null, correction_id: null, channel: "email", retries: 1, created_at: "2026-08-14T10:00:00Z", asked_at: "2026-08-14T10:05:00Z", answered_at: null, expires_at: "2026-08-20T10:00:00Z", resolved_at: null }] },
      isLoading: false,
      isError: false,
    });
  });

  it("runs a privacy-safe, URL-filtered hunt queue and starts manual work", async () => {
    const loaded = await loadPage("app/(console)/manage/hunting/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    const user = userEvent.setup();
    renderPage(loaded.default);

    expect(screen.getByRole("region", { name: "Hunt operations" })).toHaveTextContent("secure owner link");
    expect(screen.getByRole("checkbox", { name: "Open hunts only" })).toBeChecked();
    expect(useHunts).toHaveBeenCalledWith("alpha", true);
    expect(screen.getByRole("table", { name: "Hunt queue" })).toHaveTextContent("Who owns key rotation?");
    expect(document.body).not.toHaveTextContent(/magic|token|hash/i);

    await user.click(screen.getByRole("button", { name: "Start manual hunt" }));
    const dialog = screen.getByRole("dialog", { name: "Start manual hunt" });
    await user.type(within(dialog).getByRole("textbox", { name: "Question" }), "Who owns incident response?");
    await user.type(within(dialog).getByRole("textbox", { name: "Topics" }), "security, general");
    await user.click(within(dialog).getByRole("button", { name: "Start hunt" }));
    await waitFor(() => expect(askHunt).toHaveBeenCalledWith({ question: "Who owns incident response?", topics: ["security", "general"] }));
  });
});

describe("Skill lifecycle governance", () => {
  beforeEach(() => {
    pathname = "/manage/skills";
    search = "state=all";
    createSkill.mockReset();
    validateSkill.mockReset();
    archiveSkill.mockReset();
  });

  it("uses explicit lifecycle state, staleness and optimistic versions", async () => {
    const loaded = await loadPage("app/(console)/manage/skills/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    const user = userEvent.setup();
    renderPage(loaded.default);

    expect(screen.getByRole("region", { name: "Skill governance" })).toHaveTextContent("proposed → active → archived");
    const table = screen.getByRole("table", { name: "Skill lifecycle" });
    expect(within(table).getByText("Rotate keys")).toBeVisible();
    expect(within(table).getByText("Stale")).toBeVisible();
    await user.click(within(table).getByRole("button", { name: "Validate Rotate keys" }));
    await waitFor(() => expect(validateSkill).toHaveBeenCalledWith({ slug: "rotate-keys", expectedVersion: 7 }));
    expect(document.body).not.toHaveTextContent(/instructions body/i);
  });
});
