import type { ReactNode } from "react";

/** Public identity routes deliberately stay outside the authenticated application shell. */
export default function PublicLayout({ children }: { children: ReactNode }) {
  return children;
}
