import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { DesignSystemCatalog } from "@/components/design-system-catalog";
import { ThemeSelector } from "@/components/theme-selector";
import { Dialog } from "@/components/ui/dialog";
import { Tabs } from "@/components/ui/tabs";

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
});
