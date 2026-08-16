"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { AuthBoundary } from "@/components/auth-boundary";
import { BrandMark } from "@/components/brand-mark";
import { LanguageSelector } from "@/components/language-selector";
import { ThemeSelector } from "@/components/theme-selector";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Menu, MenuItem } from "@/components/ui/menu";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { logout } from "@/lib/api/auth";
import { useMe } from "@/lib/api/hooks";
import type { Me } from "@/lib/api/types";
import { useT } from "@/lib/i18n/context";
import {
  CONSOLE_NAV_GROUPS,
  CONSOLE_ROUTES,
  isActiveRoute,
  type ConsoleRoute,
} from "@/lib/navigation/routes";
import { ProjectScopeProvider, useProjectScope } from "@/lib/scope/project-scope";

const RAIL_STORAGE_KEY = "rsc-brain.rail";

function canAccess(route: ConsoleRoute, session: Me, projectCapabilities: readonly string[]): boolean {
  if (!route.capability) return route.scope !== "project" || session.memberships.length > 0;
  const capabilities = route.scope === "platform" ? session.platform_capabilities : projectCapabilities;
  return capabilities.includes(route.capability);
}

function Navigation({
  compact,
  pathname,
  session,
  projectCapabilities,
  onNavigate,
}: {
  compact: boolean;
  pathname: string;
  session: Me;
  projectCapabilities: readonly string[];
  onNavigate?: () => void;
}) {
  const t = useT();

  return (
    <div className="space-y-5">
      {CONSOLE_NAV_GROUPS.map((group) => {
        const routes = group.routes.filter((route) => canAccess(route, session, projectCapabilities));
        if (routes.length === 0) return null;
        return (
          <section key={group.id} aria-labelledby={`nav-group-${group.id}`}>
            <p
              id={`nav-group-${group.id}`}
              className={compact ? "sr-only" : "mb-1 px-3 font-mono text-[0.625rem] font-medium uppercase tracking-[0.14em] text-text-tertiary"}
            >
              {t(group.labelKey)}
            </p>
            <div className="space-y-1">
              {routes.map((route) => {
                const active = isActiveRoute(pathname, route.href);
                return (
                  <Link
                    key={route.href}
                    href={route.href}
                    aria-label={compact ? t(route.labelKey) : undefined}
                    aria-current={active ? "page" : undefined}
                    title={compact ? t(route.labelKey) : undefined}
                    onClick={onNavigate}
                    className={`group flex min-h-10 items-center rounded-[var(--radius-control)] border-l-2 text-sm transition-colors duration-[var(--motion-fast)] ${
                      compact ? "justify-center px-1 font-mono text-[0.6875rem]" : "px-3"
                    } ${
                      active
                        ? "border-l-interactive bg-selected font-medium text-text-primary"
                        : "border-l-transparent text-text-secondary hover:bg-surface-subtle hover:text-text-primary"
                    }`}
                  >
                    {compact ? route.shortLabel : t(route.labelKey)}
                  </Link>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ScopeShell({
  session,
  title,
  description,
  children,
}: {
  session: Me;
  title: string;
  description?: string;
  children: (project: string) => ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const t = useT();
  const { project, capabilities, switchProject } = useProjectScope();
  const [compact, setCompact] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const navigationTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setCompact(window.localStorage.getItem(RAIL_STORAGE_KEY) === "compact");
  }, []);

  const closeDrawer = () => {
    setDrawerOpen(false);
    window.requestAnimationFrame(() => navigationTriggerRef.current?.focus());
  };

  const selectedRoute = useMemo(
    () => CONSOLE_ROUTES.find((route) => isActiveRoute(pathname, route.href)),
    [pathname],
  );
  const routeAllowed = !selectedRoute || canAccess(selectedRoute, session, capabilities);

  const signOut = async () => {
    try {
      await logout();
    } finally {
      queryClient.clear();
      router.replace("/login");
    }
  };

  return (
    <>
      <a
        href="#main-content"
        className="fixed left-3 top-3 z-[100] -translate-y-20 rounded-[var(--radius-control)] bg-interactive px-3 py-2 text-sm font-medium text-on-interactive focus:translate-y-0"
      >
        {t("common.skipToContent")}
      </a>
      <div
        data-testid="shell-layout"
        data-rail-state={compact ? "compact" : "expanded"}
        className={`min-h-screen bg-canvas lg:grid ${
          compact ? "lg:grid-cols-[3.5rem_minmax(0,1fr)]" : "lg:grid-cols-[14.5rem_minmax(0,1fr)]"
        }`}
      >
        <aside className="hidden border-r border-border bg-surface lg:flex lg:flex-col">
          <div className={`flex h-14 items-center border-b border-border ${compact ? "justify-center px-2" : "px-4"}`}>
            <BrandMark compact={compact} />
          </div>
          <nav
            data-testid="desktop-navigation"
            aria-label={t("nav.primaryLabel")}
            className="min-h-0 flex-1 overflow-y-auto px-2 py-4"
          >
            <Navigation
              compact={compact}
              pathname={pathname}
              session={session}
              projectCapabilities={capabilities}
            />
          </nav>
          <div className="border-t border-border p-2">
            <Button
              variant="ghost"
              size={compact ? "icon" : "sm"}
              className={compact ? "w-full" : "w-full justify-start"}
              aria-label={compact ? t("nav.expand") : t("nav.collapse")}
              aria-expanded={!compact}
              onClick={() => {
                const next = !compact;
                setCompact(next);
                window.localStorage.setItem(RAIL_STORAGE_KEY, next ? "compact" : "expanded");
              }}
            >
              <span aria-hidden="true">{compact ? "→" : "←"}</span>
              {compact ? null : t("nav.collapse")}
            </Button>
          </div>
        </aside>

        <div className="min-w-0">
          <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-border bg-canvas/95 px-4 backdrop-blur lg:px-6">
            <div className="flex items-center gap-2 lg:hidden">
              <Button
                ref={navigationTriggerRef}
                variant="ghost"
                size="icon"
                aria-label={t("nav.openPrimary")}
                aria-expanded={drawerOpen}
                aria-controls="primary-navigation-drawer"
                onClick={() => setDrawerOpen(true)}
              >
                <span aria-hidden="true" className="font-mono text-lg leading-none">≡</span>
              </Button>
              <BrandMark compact />
            </div>
            <div className="ml-auto flex min-w-0 items-center gap-2">
              <Select
                aria-label={t("common.project")}
                className="max-w-48 min-w-32"
                value={project}
                onChange={(event) => void switchProject(event.target.value)}
              >
                {session.platform_capabilities.length > 0 ? <option value="">{t("common.all")}</option> : null}
                {session.memberships.map((membership) => (
                  <option key={membership.project} value={membership.project}>{membership.project}</option>
                ))}
              </Select>
              <div className="hidden items-center gap-2 sm:flex">
                <LanguageSelector />
                <ThemeSelector />
              </div>
              <Menu label={session.identity.email} aria-label={t("nav.account")}>
                <MenuItem onClick={() => void signOut()}>{t("common.logOut")}</MenuItem>
              </Menu>
            </div>
          </header>

          <main
            id="main-content"
            tabIndex={-1}
            className="mx-auto max-w-[96rem] space-y-6 px-4 py-6 lg:px-8 lg:py-8"
          >
            <PageHeader title={title} description={description} />
            {!routeAllowed ? (
              <div role="alert" className="rounded-[var(--radius-panel)] border border-danger/40 bg-danger-muted p-4 text-sm">
                {t("errors.forbidden")}
              </div>
            ) : project || selectedRoute?.scope !== "project" ? (
              children(project)
            ) : (
              <p className="text-sm text-text-secondary">{t("common.selectProject")}</p>
            )}
          </main>
        </div>
      </div>

      <Drawer
        id="primary-navigation-drawer"
        open={drawerOpen}
        onClose={closeDrawer}
        title={t("nav.drawerTitle")}
        closeLabel={t("common.close")}
      >
        <nav aria-label={t("nav.primaryLabel")}>
          <Navigation
            compact={false}
            pathname={pathname}
            session={session}
            projectCapabilities={capabilities}
            onNavigate={closeDrawer}
          />
        </nav>
        <div className="mt-6 grid grid-cols-2 gap-2 border-t border-border pt-4 sm:hidden">
          <LanguageSelector />
          <ThemeSelector />
        </div>
      </Drawer>
    </>
  );
}

function AuthenticatedShell({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: (project: string) => ReactNode;
}) {
  const { data: session } = useMe();
  if (!session) return null;
  return (
    <ProjectScopeProvider session={session}>
      <ScopeShell session={session} title={title} description={description}>
        {children}
      </ScopeShell>
    </ProjectScopeProvider>
  );
}

export function AppShell({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: (project: string) => ReactNode;
}) {
  return (
    <AuthBoundary>
      <AuthenticatedShell title={title} description={description}>
        {children}
      </AuthenticatedShell>
    </AuthBoundary>
  );
}
