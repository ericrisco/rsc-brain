import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const appFile = (relativePath: string) => resolve(process.cwd(), relativePath);
const readAppFile = (relativePath: string) => readFileSync(appFile(relativePath), "utf8");

/**
 * This is intentionally RED until T012 delivers the console design system. It records
 * user-facing accessibility and theming contracts rather than brittle markup snapshots.
 */
describe("console design-system contract (RED until T012)", () => {
  it("defines semantic, role-based colour tokens instead of only utility colours", () => {
    const css = readAppFile("app/globals.css");

    expect({
      canvas: css.includes("--color-canvas"),
      surface: css.includes("--color-surface"),
      text: css.includes("--color-text"),
      interactive: css.includes("--color-interactive"),
    }).toEqual({ canvas: true, surface: true, text: true, interactive: true });
  });

  it("loads IBM Plex as the console identity font", () => {
    const css = readAppFile("app/globals.css");
    const layout = readAppFile("app/layout.tsx");

    expect({
      fontDeclared: /IBM Plex/i.test(css),
      fontApplied: /font-ibm-plex|fontFamily/i.test(`${css}\n${layout}`),
    }).toEqual({ fontDeclared: true, fontApplied: true });
  });

  it("sets System, Light, and Dark theme state before first paint", () => {
    const layout = readAppFile("app/layout.tsx");

    expect({
      themeAttribute: /data-theme/.test(layout),
      prePaintScript: /beforeInteractive|theme.*script/i.test(layout),
      systemPreference: /prefers-color-scheme/.test(layout),
    }).toEqual({ themeAttribute: true, prePaintScript: true, systemPreference: true });
  });

  it("sets the selected ES or EN document locale before client effects", () => {
    const layout = readAppFile("app/layout.tsx");

    expect({
      localeAwareHtml: /<html[^>]+lang=\{[^}]*locale/.test(layout),
      staticEnglishOnly: !/<html\s+lang="en"/.test(layout),
    }).toEqual({ localeAwareHtml: true, staticEnglishOnly: true });
  });

  it("provides app-shell landmarks and the primitives required by console workflows", () => {
    const shell = readAppFile("components/page-shell.tsx");
    const requiredPrimitives = ["dialog", "tabs", "table", "toast"];

    expect({
      navigationLandmark: /<nav\b/.test(shell),
      skipLink: /href=["']#main-content["']/.test(shell),
      primitives: requiredPrimitives.every((name) => existsSync(appFile(`components/ui/${name}.tsx`))),
    }).toEqual({ navigationLandmark: true, skipLink: true, primitives: true });
  });
});
