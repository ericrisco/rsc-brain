import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, expect } from "vitest";
import { toHaveNoViolations } from "jest-axe";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

// Node 25 exposes an incomplete experimental global localStorage to jsdom. Replace it
// with browser-compatible storage so tests behave the same under the Node 22 CI runtime.
Object.defineProperty(window, "localStorage", { configurable: true, value: memoryStorage() });
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  }),
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

expect.extend(toHaveNoViolations);

afterEach(() => {
  cleanup();
});
