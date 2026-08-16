import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const appFile = (relativePath: string) => resolve(process.cwd(), relativePath);
const readAppFile = (relativePath: string) => readFileSync(appFile(relativePath), "utf8");

function productionTsxFiles(directory: string): string[] {
  return readdirSync(appFile(directory), { withFileTypes: true }).flatMap((entry) => {
    const relativePath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return productionTsxFiles(relativePath);
    return extname(entry.name) === ".tsx" ? [relativePath] : [];
  });
}

const primitiveFiles = [
  "badge",
  "banner",
  "button",
  "checkbox",
  "data-table",
  "dialog",
  "drawer",
  "empty-state",
  "filter-bar",
  "icon-button",
  "input",
  "link",
  "live-region",
  "menu",
  "page-header",
  "pagination",
  "select",
  "skeleton",
  "table",
  "tabs",
  "toast",
  "tooltip",
  "trust-rail",
] as const;

/**
 * These checks pin decisions rather than class-name snapshots: OKLCH source
 * colours, semantic roles, deterministic first paint, brand assets and one primitive catalogue.
 */
describe("Quiet Control Room design-system contract", () => {
  it("defines the complete semantic colour system from the ratified OKLCH source", () => {
    const css = readAppFile("app/globals.css");
    const requiredTokens = [
      "--color-canvas",
      "--color-surface",
      "--color-surface-subtle",
      "--color-text-primary",
      "--color-text-secondary",
      "--color-border",
      "--color-border-strong",
      "--color-interactive",
      "--color-on-interactive",
      "--color-focus",
      "--color-success",
      "--color-success-muted",
      "--color-warning",
      "--color-warning-muted",
      "--color-danger",
      "--color-danger-muted",
      "--color-on-danger",
    ];

    expect({
      allSemanticTokens: requiredTokens.every((token) => css.includes(token)),
      instrumentNeutral: css.includes("oklch(0.985 0.002 230)"),
      instrumentCyan: css.includes("oklch(0.650 0.150 210)"),
      explicitLight: /\[data-theme=["']light["']\]/.test(css),
      explicitDark: /\[data-theme=["']dark["']\]/.test(css),
      systemPreference: /prefers-color-scheme:\s*dark/.test(css),
    }).toEqual({
      allSemanticTokens: true,
      instrumentNeutral: true,
      instrumentCyan: true,
      explicitLight: true,
      explicitDark: true,
      systemPreference: true,
    });
  });

  it("defines Precision Grid geometry, type, data and reduced-motion tokens", () => {
    const css = readAppFile("app/globals.css");

    expect({
      fourPixelUnit: css.includes("--space-unit: 0.25rem"),
      compactRadius: css.includes("--radius-control: 0.25rem"),
      panelRadius: css.includes("--radius-panel: 0.375rem"),
      overlayRadius: css.includes("--radius-overlay: 0.5rem"),
      fastMotion: css.includes("--motion-fast: 120ms"),
      stateMotion: css.includes("--motion-state: 160ms"),
      tabularData: /font-variant-numeric:\s*tabular-nums/.test(css),
      reducedMotion: /prefers-reduced-motion:\s*reduce/.test(css),
    }).toEqual({
      fourPixelUnit: true,
      compactRadius: true,
      panelRadius: true,
      overlayRadius: true,
      fastMotion: true,
      stateMotion: true,
      tabularData: true,
      reducedMotion: true,
    });
  });

  it("self-hosts IBM Plex Sans and Mono as the only application families", () => {
    const layout = readAppFile("app/layout.tsx");
    const packageJson = readAppFile("package.json");

    expect({
      sansPackage: packageJson.includes("@fontsource-variable/ibm-plex-sans"),
      monoPackage: packageJson.includes("@fontsource/ibm-plex-mono"),
      sansLoaded: /ibm-plex-sans/i.test(layout),
      monoLoaded: /ibm-plex-mono/i.test(layout),
      variablesApplied: /--font-(sans|mono)/.test(layout),
    }).toEqual({
      sansPackage: true,
      monoPackage: true,
      sansLoaded: true,
      monoLoaded: true,
      variablesApplied: true,
    });
  });

  it("sets System, Light or Dark and ES or EN before hydration", () => {
    const layout = readAppFile("app/layout.tsx");
    const themeScript = existsSync(appFile("components/theme-script.tsx"))
      ? readAppFile("components/theme-script.tsx")
      : "";
    const middleware = readAppFile("middleware.ts");
    const scriptDirective = middleware.match(/script-src[^"`]*/)?.[0] ?? "";

    expect({
      themeAttribute: /data-theme/.test(`${layout}\n${themeScript}`),
      prePaintScript: /dangerouslySetInnerHTML/.test(themeScript),
      persistedTheme: /rsc-brain\.theme/.test(themeScript),
      systemPreference: /prefers-color-scheme/.test(themeScript),
      localeCookie: /rsc-brain\.locale/.test(layout),
      localeAwareHtml: /<html[^>]+lang=\{locale\}/.test(layout),
      hydrationSafe: /suppressHydrationWarning/.test(layout),
      nonceForwarded: /<ThemeScript nonce=\{nonce\}/.test(layout),
      cspNonce: /Content-Security-Policy/.test(middleware) && /'nonce-\$\{nonce\}'/.test(middleware),
      strictDynamic: scriptDirective.includes("'strict-dynamic'"),
      noUnsafeInlineScript: !scriptDirective.includes("'unsafe-inline'"),
    }).toEqual({
      themeAttribute: true,
      prePaintScript: true,
      persistedTheme: true,
      systemPreference: true,
      localeCookie: true,
      localeAwareHtml: true,
      hydrationSafe: true,
      nonceForwarded: true,
      cspNonce: true,
      strictDynamic: true,
      noUnsafeInlineScript: true,
    });
  });

  it("ships typographic marks and an application icon without decorative effects", () => {
    const assets = ["public/brand/wordmark.svg", "public/brand/monogram.svg", "app/icon.svg"];
    const contents = assets.map((path) =>
      existsSync(appFile(path)) ? readAppFile(path) : "",
    );
    const joined = contents.join("\n");

    expect({
      assetsExist: assets.every((path) => existsSync(appFile(path))),
      currentColor: contents.every((asset) => asset.includes("currentColor")),
      typographicMarks: joined.includes("rsc-brain") && joined.includes("r/"),
      noGradientOrFilter: contents.every(
        (asset) => !/<(?:linearGradient|radialGradient|filter)\b/.test(asset),
      ),
    }).toEqual({
      assetsExist: true,
      currentColor: true,
      typographicMarks: true,
      noGradientOrFilter: true,
    });
  });

  it("provides one shared primitive catalogue and semantic shell landmarks", () => {
    const shell = readAppFile("components/page-shell.tsx");

    expect({
      primitives: primitiveFiles.every((name) => existsSync(appFile(`components/ui/${name}.tsx`))),
      catalogue: existsSync(appFile("components/design-system-catalog.tsx")),
      navigationLandmark: /<nav\b/.test(shell),
      mobileNavigation: /<Drawer\b/.test(shell) && /nav\.openPrimary/.test(shell),
      skipLink: /href=["']#main-content["']/.test(shell),
      mainTarget: /id=["']main-content["']/.test(shell),
    }).toEqual({
      primitives: true,
      catalogue: true,
      navigationLandmark: true,
      mobileNavigation: true,
      skipLink: true,
      mainTarget: true,
    });
  });

  it("uses semantic theme tokens throughout every production route and component", () => {
    const productionFiles = [...productionTsxFiles("app"), ...productionTsxFiles("components")];
    const violations = productionFiles.filter((path) => {
      const source = readAppFile(path);
      return /(?:dark:|(?:bg|text|border|ring|placeholder)-(?:neutral|slate|gray|zinc|stone|red|green|amber|emerald|white)-)/m.test(
        source,
      );
    });

    expect(violations).toEqual([]);
  });
});
