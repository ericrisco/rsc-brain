"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { BrandMark } from "@/components/brand-mark";
import { LanguageSelector } from "@/components/language-selector";
import { ThemeSelector } from "@/components/theme-selector";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { useMe } from "@/lib/api/hooks";
import { useT } from "@/lib/i18n/context";

const navigation = [
  ["/", "Overview"],
  ["/knowledge", "Knowledge"],
  ["/review", "Review"],
  ["/graph", "Graph"],
  ["/observability", "Observability"],
  ["/connections", "Connections"],
  ["/audit", "Audit"],
  ["/usage", "Usage"],
  ["/product-metrics", "Product metrics"],
] as const;

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
  const router = useRouter();
  const pathname = usePathname();
  const t = useT();
  const { data: me, isError } = useMe();
  const [project, setProject] = useState("");

  useEffect(() => {
    if (isError) router.replace("/login");
  }, [isError, router]);
  useEffect(() => {
    if (me && !project && me.memberships[0]) setProject(me.memberships[0].project);
  }, [me, project]);

  if (!me) return <main id="main-content" className="p-6 text-sm text-text-secondary">{t("common.loading")}</main>;

  return (
    <>
      <a
        href="#main-content"
        className="fixed left-3 top-3 z-[100] -translate-y-20 rounded-[var(--radius-control)] bg-interactive px-3 py-2 text-sm font-medium text-on-interactive focus:translate-y-0"
      >
        Skip to content
      </a>
      <div className="min-h-screen bg-canvas lg:grid lg:grid-cols-[14.5rem_minmax(0,1fr)]">
        <aside className="hidden border-r border-border bg-surface lg:flex lg:flex-col">
          <div className="flex h-14 items-center border-b border-border px-4">
            <BrandMark />
          </div>
          <nav aria-label="Primary" className="flex-1 space-y-1 px-2 py-3">
            {navigation.map(([href, label]) => {
              const active = href === "/" ? pathname === href : pathname.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={`flex min-h-10 items-center rounded-[var(--radius-control)] border-l-2 px-3 text-sm transition-colors duration-[var(--motion-fast)] ${
                    active
                      ? "border-l-interactive bg-selected font-medium text-text-primary"
                      : "border-l-transparent text-text-secondary hover:bg-surface-subtle hover:text-text-primary"
                  }`}
                >
                  {label}
                </Link>
              );
            })}
          </nav>
          <p className="border-t border-border px-4 py-3 font-mono text-[0.6875rem] text-text-secondary">
            CONTROL PLANE / 0.13
          </p>
        </aside>
        <div className="min-w-0">
          <header className="sticky top-0 z-40 flex min-h-14 flex-wrap items-center justify-between gap-2 border-b border-border bg-canvas/95 px-4 backdrop-blur-sm lg:px-6">
            <div className="lg:hidden">
              <BrandMark compact />
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Select
                aria-label={t("common.project")}
                className="min-w-40"
                value={project}
                onChange={(event) => setProject(event.target.value)}
              >
                {me.memberships.map((membership) => (
                  <option key={membership.project} value={membership.project}>
                    {membership.project}
                  </option>
                ))}
              </Select>
              <LanguageSelector />
              <ThemeSelector />
            </div>
          </header>
          <main id="main-content" tabIndex={-1} className="mx-auto max-w-[96rem] space-y-6 px-4 py-6 lg:px-8 lg:py-8">
            <PageHeader title={title} description={subtitle} />
            {project ? children(project) : <p className="text-sm text-text-secondary">{t("common.selectProject")}</p>}
          </main>
        </div>
      </div>
    </>
  );
}
