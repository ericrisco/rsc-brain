import type { ReactNode } from "react";

/** Authenticated route boundary; page modules own content while AppShell owns all control chrome. */
export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return children;
}
