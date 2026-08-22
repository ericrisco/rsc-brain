import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

const rootDir = fileURLToPath(new URL("./", import.meta.url));

/**
 * Unit/component tests use jsdom while retaining the app's `@/*` import contract.
 * This deliberately does not replace Next's runtime config: server and browser E2E
 * coverage continue to run through Next and Playwright.
 */
export default defineConfig({
  // vitest 4 / vite 8 transform with oxc rather than esbuild, and `esbuild.jsx` is gone from the
  // config type. The option existed only to force the automatic JSX runtime; oxc derives that from
  // `tsconfig.json`, which sets `"jsx": "react-jsx"` — the automatic runtime — so stating it here is both
  // unnecessary and no longer typeable. Removed rather than translated to `oxc.jsx`: the transform
  // that actually runs is the one the tests exercise, and they pass without it.
  resolve: {
    alias: {
      "@": rootDir,
      "server-only": resolve(rootDir, "tests/server-only.ts"),
    },
  },
  test: {
    environment: "jsdom",
    environmentOptions: {
      jsdom: { url: "http://localhost" },
    },
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    restoreMocks: true,
  },
});
