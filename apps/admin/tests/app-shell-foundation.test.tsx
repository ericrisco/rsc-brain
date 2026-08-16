import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PageShell } from "@/components/page-shell";
import { LanguageProvider } from "@/lib/i18n/context";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/audit",
  useRouter: () => ({ replace }),
}));

vi.mock("@/lib/api/hooks", () => ({
  useMe: () => ({
    data: {
      id: "user-1",
      email: "operator@example.invalid",
      memberships: [{ project: "atlas", role: "viewer", topics: ["general"] }],
    },
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
      <LanguageProvider initialLocale="en">
        <PageShell title="Audit">{(project) => <p>Project {project}</p>}</PageShell>
      </LanguageProvider>,
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
