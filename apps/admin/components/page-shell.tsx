"use client";

import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";

/**
 * Shared chrome for the SPEC-26 views: auth guard, project selector, language selector, and a back
 * link — so each page only renders its own content, scoped to the chosen project.
 */
export function PageShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: (project: string) => ReactNode;
}) {
  return <AppShell title={title} description={subtitle}>{children}</AppShell>;
}
