import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PageShell } from "@/components/page-shell";
import { LanguageProvider } from "@/lib/i18n/context";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/audit",
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/api/hooks", () => ({
  useMe: () => ({
    data: {
      identity: { id: "user-1", email: "operator@example.invalid", role: "member" },
      user: { id: "user-1", email: "operator@example.invalid", role: "member" },
      is_owner: false,
      platform_capabilities: [],
      memberships: [
        {
          project: "atlas",
          role: "viewer",
          capabilities: ["project.manage.read"],
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

describe("responsive application shell", () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  });

  it("exposes primary navigation in a modal drawer and restores trigger focus", async () => {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LanguageProvider initialLocale="en">
          <PageShell title="Audit">{(project) => <p>Project {project}</p>}</PageShell>
        </LanguageProvider>
      </QueryClientProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Open primary navigation" });
    expect(trigger).toHaveAttribute("aria-controls", "primary-navigation-drawer");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);

    expect(await screen.findByRole("dialog", { name: "Navigation" })).toBeVisible();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("navigation", { name: "Primary navigation" })).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
