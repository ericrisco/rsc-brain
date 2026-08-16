import { act } from "react";
import { useEffect, type ReactNode } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import { LanguageSelector } from "@/components/language-selector";
import { LanguageProvider } from "@/lib/i18n/context";

function HydrationProbe({ children, onCleanup }: { children: ReactNode; onCleanup: () => void }) {
  useEffect(() => onCleanup, [onCleanup]);
  return <>{children}</>;
}

describe("frontend test harness", () => {
  it("hydrates an interactive component, runs axe, and cleans up its client tree", async () => {
    const onCleanup = vi.fn();
    const container = document.createElement("div");
    const app = (
      <LanguageProvider>
        <HydrationProbe onCleanup={onCleanup}>
          <LanguageSelector />
        </HydrationProbe>
      </LanguageProvider>
    );

    window.localStorage.clear();
    container.innerHTML = renderToString(app);
    document.body.append(container);

    const root = hydrateRoot(container, app);
    await act(async () => {});

    const language = screen.getByRole("combobox", { name: "Language" });
    expect(language).toHaveValue("en");

    await userEvent.setup().selectOptions(language, "es");
    expect(language).toHaveValue("es");
    expect(window.localStorage.getItem("rsc-brain.locale")).toBe("es");
    expect(document.documentElement).toHaveAttribute("lang", "es");

    expect(await axe(container)).toHaveNoViolations();

    await act(async () => root.unmount());
    expect(onCleanup).toHaveBeenCalledOnce();
    expect(container).toBeEmptyDOMElement();
    container.remove();
  });
});
