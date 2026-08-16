import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ComponentType } from "react";

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/lib/i18n/context";

let pathname = "/knowledge";
let search = "";
const replace = vi.fn();
const promoteGap = vi.fn();
const revertCorrection = vi.fn();
const resolveChunk = vi.fn();
const resolveMerge = vi.fn();

const session = {
  identity: { id: "user-1", email: "curator@example.invalid", role: "member" },
  user: { id: "user-1", email: "curator@example.invalid", role: "member" },
  is_owner: false,
  platform_capabilities: [],
  memberships: [
    {
      project: "alpha",
      role: "project-admin",
      capabilities: ["knowledge.read", "knowledge.review.decide", "hunt.manage"],
      allowed_topics: ["general"],
      can_curate: true,
    },
  ],
  preference_metadata: { theme: "system", locale: "en" },
};

const humanGaps = [
  {
    id: "gap-human",
    query_text: "How do we rotate keys?",
    topics: ["general"],
    count: 7,
    status: "open",
    last_seen_at: "2026-08-16T10:00:00Z",
  },
];
const agentGaps = [
  {
    id: "gap-agent",
    query_text: null,
    topics: ["general"],
    count: 3,
    status: "open",
    last_seen_at: "2026-08-15T10:00:00Z",
  },
];
const reviewItems = [
  {
    source: "guardrail",
    id: "chunk-1",
    preview: "Untrusted incident response instructions",
    detail: { kind: "paragraph", document_id: "doc-1", tags: ["general"] },
    content_type: "untrusted_external_content",
  },
  {
    source: "entity_merge",
    id: "merge-1",
    preview: "merge duplicate → canonical",
    detail: {
      canonical_entity_id: "canonical-1",
      duplicate_entity_id: "duplicate-1",
      confidence: 0.82,
    },
    content_type: "untrusted_external_content",
  },
  {
    source: "agent_correction",
    id: "correction-1",
    preview: "old claim → proposed claim",
    detail: { target_claim: "claim-1" },
    content_type: "untrusted_external_content",
  },
];

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
  useGaps: (_project: string, agents: boolean) => ({
    data: { gaps: agents ? agentGaps : humanGaps },
    isLoading: false,
    isError: false,
  }),
  useHunts: () => ({
    data: {
      hunts: [
        {
          id: "hunt-1",
          type: "gap",
          state: "asked",
          question: "Who owns key rotation?",
          person_id: "person-1",
          gap_id: "gap-human",
          correction_id: null,
          channel: "email",
          retries: 1,
          created_at: "2026-08-14T10:00:00Z",
          asked_at: "2026-08-14T10:05:00Z",
          answered_at: null,
          expires_at: "2026-08-20T10:00:00Z",
          resolved_at: null,
        },
      ],
    },
    isLoading: false,
    isError: false,
  }),
  useDisputed: () => ({
    data: {
      claims: [
        {
          id: "claim-1",
          text: "Keys rotate every 30 days",
          tags: ["general"],
          credibility: 0.62,
          valid_to: null,
        },
      ],
    },
    isLoading: false,
    isError: false,
  }),
  useResolutions: () => ({
    data: {
      resolutions: [
        {
          verdict: "contradict",
          confidence: 0.91,
          judge_version: "judge-v3",
          winner: { claim_id: "claim-1", text: "Rotate every 30 days", credibility: 0.88, valid_to: null },
          loser: { claim_id: "claim-2", text: "Rotate every 90 days", credibility: 0.41, valid_to: "2026-08-12T10:00:00Z" },
          created_at: "2026-08-12T10:00:00Z",
        },
      ],
    },
    isLoading: false,
    isError: false,
  }),
  useCorrections: () => ({
    data: {
      corrections: [
        {
          id: "correction-1",
          target_claim: "claim-1",
          new_claim: "claim-3",
          status: "applied",
          role_applied: "owner_direct",
          author_id: "user-1",
          on_behalf_of: null,
          hunt_id: null,
          before_text: "Rotate every 90 days",
          after_text: "Rotate every 30 days",
          created_at: "2026-08-12T10:00:00Z",
          resolved_at: "2026-08-12T10:02:00Z",
        },
      ],
    },
    isLoading: false,
    isError: false,
  }),
  useCorrectionMetrics: () => ({
    data: { total: 1, by_status: { applied: 1 }, applied: 1, routed_hunt: 0, rejected: 0, revert_rate: 0, correction_wars: 1, ownership_coverage: 0.75 },
    isLoading: false,
    isError: false,
  }),
  usePromoteGap: () => ({ mutateAsync: promoteGap, mutate: promoteGap, isPending: false }),
  useRevertCorrection: () => ({ mutateAsync: revertCorrection, mutate: revertCorrection, isPending: false, isError: false }),
  useReviewQueue: (_project: string, source?: string) => ({
    data: {
      items: source ? reviewItems.filter((item) => item.source === source) : reviewItems,
      counts: { guardrail: 1, entity_merge: 1, agent_correction: 1 },
    },
    isLoading: false,
    isError: false,
  }),
  useResolveChunk: () => ({ mutateAsync: resolveChunk, mutate: resolveChunk, isPending: false }),
  useResolveMerge: () => ({ mutateAsync: resolveMerge, mutate: resolveMerge, isPending: false }),
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

describe("Living knowledge workspace", () => {
  beforeEach(() => {
    pathname = "/knowledge";
    search = "area=gaps&audience=human";
    replace.mockReset();
    promoteGap.mockReset().mockResolvedValue({ outcome: "promoted" });
    revertCorrection.mockReset().mockResolvedValue({ outcome: "reverted" });
    session.memberships[0]!.role = "project-admin";
  });

  it("separates the five URL-backed knowledge tasks and summarizes posture", async () => {
    const loaded = await loadPage("app/(console)/knowledge/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    const user = userEvent.setup();
    renderPage(loaded.default);

    expect(screen.getByRole("heading", { level: 1, name: "Living knowledge" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Knowledge posture" })).toBeVisible();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Gaps",
      "Hunts",
      "Disputed",
      "Resolutions",
      "Corrections",
    ]);
    await user.click(screen.getByRole("tab", { name: "Hunts" }));
    expect(replace).toHaveBeenCalledWith("/knowledge?area=hunts&audience=human", { scroll: false });
  });

  it("renders gap evidence as a table and confirms agent-gap promotion", async () => {
    search = "area=gaps&audience=agent";
    const loaded = await loadPage("app/(console)/knowledge/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    const user = userEvent.setup();
    renderPage(loaded.default);

    const table = screen.getByRole("table", { name: "Knowledge gaps" });
    expect(within(table).getByText("Query text hidden by policy")).toBeVisible();
    expect(within(table).getByText("3")).toBeVisible();
    expect(within(table).getByText("general")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Promote gap to hunt" }));
    const dialog = screen.getByRole("dialog", { name: "Promote gap" });
    expect(dialog).toHaveTextContent("contact workflow");
    expect(dialog).toHaveTextContent("general");
    await user.click(within(dialog).getByRole("button", { name: "Promote now" }));
    await waitFor(() => expect(promoteGap).toHaveBeenCalledWith("gap-agent"));
  });

  it("explains a resolution without relying on color or strike-through", async () => {
    search = "area=resolutions";
    const loaded = await loadPage("app/(console)/knowledge/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    renderPage(loaded.default);

    const region = screen.getByRole("region", { name: "Contradiction resolutions" });
    expect(within(region).getByText("Winner")).toBeVisible();
    expect(within(region).getByText("Superseded")).toBeVisible();
    expect(region).toHaveTextContent("judge-v3");
    expect(region).toHaveTextContent("91%");
    expect(region.querySelector(".line-through")).toBeNull();
  });

  it("restates correction impact before an audited revert", async () => {
    search = "area=corrections";
    const loaded = await loadPage("app/(console)/knowledge/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    const user = userEvent.setup();
    renderPage(loaded.default);

    await user.click(screen.getByRole("button", { name: "Revert correction" }));
    const dialog = screen.getByRole("dialog", { name: "Revert correction" });
    expect(dialog).toHaveTextContent("claim-1");
    expect(dialog).toHaveTextContent("audited");
    await user.click(within(dialog).getByRole("button", { name: "Revert now" }));
    await waitFor(() => expect(revertCorrection).toHaveBeenCalledWith("correction-1"));
  });
});

describe("Unified review workspace", () => {
  beforeEach(() => {
    pathname = "/review";
    search = "source=guardrail&item=chunk-1";
    replace.mockReset();
    resolveChunk.mockReset().mockResolvedValue({ outcome: "approved" });
    resolveMerge.mockReset().mockResolvedValue({ outcome: "approved" });
    session.memberships[0]!.role = "project-admin";
    session.memberships[0]!.can_curate = true;
  });

  it("uses a source-filtered split view with persistent item deep links", async () => {
    const loaded = await loadPage("app/(console)/review/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    renderPage(loaded.default);

    expect(screen.getByRole("heading", { level: 1, name: "Review queue" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Review queue" })).toBeVisible();
    const evidence = screen.getByRole("region", { name: "Review evidence" });
    expect(within(evidence).getByText("Untrusted incident response instructions")).toBeVisible();
    expect(within(evidence).getByText("Untrusted preview")).toBeVisible();
    expect(within(evidence).getByText("doc-1")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Source" })).toHaveValue("guardrail");
  });

  it("edits chunk topics and resolves from explicit review evidence", async () => {
    const loaded = await loadPage("app/(console)/review/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    const user = userEvent.setup();
    renderPage(loaded.default);

    const evidence = screen.getByRole("region", { name: "Review evidence" });
    const topics = within(evidence).getByRole("textbox", { name: "Topics" });
    await user.clear(topics);
    await user.type(topics, "general, runbook");
    await user.click(within(evidence).getByRole("button", { name: "Approve item" }));
    await waitFor(() =>
      expect(resolveChunk).toHaveBeenCalledWith({
        chunkId: "chunk-1",
        approve: true,
        tags: ["general", "runbook"],
      }),
    );
    expect(await within(evidence).findByRole("status")).toHaveTextContent("Item approved");
  });

  it("keeps review evidence visible but removes mutation controls for viewers", async () => {
    session.memberships[0]!.role = "viewer";
    session.memberships[0]!.can_curate = false;
    const loaded = await loadPage("app/(console)/review/page.tsx");
    expect(loaded?.default).toBeTypeOf("function");
    if (!loaded) return;
    renderPage(loaded.default);

    expect(screen.getByRole("region", { name: "Review evidence" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve item" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject item" })).not.toBeInTheDocument();
    expect(screen.getByText("Read-only review access")).toBeVisible();
  });
});
