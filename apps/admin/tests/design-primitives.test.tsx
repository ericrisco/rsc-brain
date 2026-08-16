import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { DesignSystemCatalog } from "@/components/design-system-catalog";
import { ThemeSelector } from "@/components/theme-selector";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Menu, MenuItem } from "@/components/ui/menu";
import { Tabs } from "@/components/ui/tabs";
import { Toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { LanguageProvider, useI18n } from "@/lib/i18n/context";

function InteractiveTabs() {
  const [value, setValue] = useState("first");
  return (
    <Tabs
      label="Test areas"
      value={value}
      onValueChange={setValue}
      items={[
        { value: "first", label: "First" },
        { value: "second", label: "Second", count: 2 },
      ]}
    >
      {value === "first" ? "First panel" : "Second panel"}
    </Tabs>
  );
}

function LocaleProbe() {
  const { locale } = useI18n();
  return <output>{locale}</output>;
}

describe("design-system runtime", () => {
  it("renders the catalogue without automated accessibility violations", async () => {
    const { container } = render(<DesignSystemCatalog />);

    expect(screen.getByRole("heading", { name: "Design-system catalogue" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Control plane posture" })).toBeVisible();
    expect(screen.getByRole("table", { name: "Credential review fixture" })).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("persists all three theme preferences and updates the root theme", async () => {
    document.documentElement.dataset.theme = "system";
    const user = userEvent.setup();
    render(<ThemeSelector />);
    const selector = screen.getByRole("combobox", { name: "Theme" });

    await user.selectOptions(selector, "dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("rsc-brain.theme")).toBe("dark");

    await user.selectOptions(selector, "light");
    expect(document.documentElement.dataset.theme).toBe("light");

    await user.selectOptions(selector, "system");
    expect(document.documentElement.dataset.theme).toBe("system");
  });

  it("moves tab selection and associates the active panel", async () => {
    const user = userEvent.setup();
    render(<InteractiveTabs />);

    await user.click(screen.getByRole("tab", { name: /Second/ }));
    expect(screen.getByRole("tab", { name: /Second/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Second panel");

    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "First" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("First panel");
  });

  it("uses the native modal boundary with labelled content", () => {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute("open");
    };

    render(
      <Dialog open onClose={() => undefined} title="Revoke credential" description="Immediate effect">
        The credential stops working immediately.
      </Dialog>,
    );

    expect(screen.getByRole("dialog", { name: "Revoke credential" })).toBeVisible();
    expect(screen.getByText("Immediate effect")).toBeVisible();
  });

  it("operates menus with arrow keys and restores focus on Escape", async () => {
    const user = userEvent.setup();
    render(
      <Menu label="Actions">
        <MenuItem>Inspect</MenuItem>
        <MenuItem>Archive</MenuItem>
      </Menu>,
    );

    const trigger = screen.getByRole("button", { name: "Actions" });
    await user.click(trigger);
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Inspect" })).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Archive" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("connects tooltip descriptions and exposes dismissible live feedback", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <>
        <Tooltip content="Copy identifier">
          <Button>Copy</Button>
        </Tooltip>
        <Toast title="Saved" description="Policy updated" onDismiss={onDismiss} duration={0} />
      </>,
    );

    expect(screen.getByRole("button", { name: "Copy" })).toHaveAccessibleDescription("Copy identifier");
    expect(screen.getByRole("status")).toHaveTextContent("Policy updated");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("treats the server locale as authoritative during hydration", () => {
    window.localStorage.setItem("rsc-brain.locale", "en");
    render(
      <LanguageProvider initialLocale="es">
        <LocaleProbe />
      </LanguageProvider>,
    );

    expect(screen.getByText("es")).toBeVisible();
    expect(document.documentElement.lang).toBe("es");
    expect(window.localStorage.getItem("rsc-brain.locale")).toBe("es");
  });
});
