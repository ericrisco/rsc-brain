export const AUTH_ROUTE = "/login" as const;

export type RouteTemplate = "overview" | "collection" | "detail" | "work-queue" | "exploration";
export type RouteScope = "platform" | "project" | "personal";

export interface ConsoleRoute {
  href: string;
  labelKey: string;
  shortLabel: string;
  scope: RouteScope;
  template: RouteTemplate;
  capability?: string;
}

export interface ConsoleNavGroup {
  id: string;
  labelKey: string;
  routes: ConsoleRoute[];
}

export const CONSOLE_NAV_GROUPS: ConsoleNavGroup[] = [
  {
    id: "overview",
    labelKey: "nav.groups.overview",
    routes: [
      { href: "/", labelKey: "nav.overview", shortLabel: "OV", scope: "project", template: "overview" },
    ],
  },
  {
    id: "knowledge",
    labelKey: "nav.groups.knowledge",
    routes: [
      { href: "/knowledge", labelKey: "nav.knowledge", shortLabel: "KN", scope: "project", template: "overview", capability: "knowledge.read" },
      { href: "/review", labelKey: "nav.review", shortLabel: "RQ", scope: "project", template: "work-queue", capability: "knowledge.review.decide" },
      { href: "/graph", labelKey: "nav.graph", shortLabel: "GR", scope: "project", template: "exploration", capability: "knowledge.read" },
    ],
  },
  {
    id: "operations",
    labelKey: "nav.groups.operations",
    routes: [
      { href: "/observability", labelKey: "nav.observability", shortLabel: "OB", scope: "project", template: "overview", capability: "knowledge.read" },
    ],
  },
  {
    id: "security",
    labelKey: "nav.groups.security",
    routes: [
      { href: "/connections", labelKey: "nav.connections", shortLabel: "CN", scope: "personal", template: "collection" },
      { href: "/audit", labelKey: "nav.audit", shortLabel: "AU", scope: "project", template: "collection", capability: "project.manage.read" },
    ],
  },
  {
    id: "resources",
    labelKey: "nav.groups.resources",
    routes: [
      { href: "/usage", labelKey: "nav.usage", shortLabel: "US", scope: "project", template: "collection", capability: "usage.read" },
      { href: "/product-metrics", labelKey: "nav.metrics", shortLabel: "PM", scope: "project", template: "overview", capability: "usage.read" },
    ],
  },
  {
    id: "management",
    labelKey: "nav.groups.management",
    routes: [
      { href: "/manage/projects", labelKey: "nav.projects", shortLabel: "PR", scope: "platform", template: "collection", capability: "platform.project.list_all" },
      { href: "/manage/users", labelKey: "nav.users", shortLabel: "UR", scope: "project", template: "collection", capability: "project.manage.read" },
      { href: "/manage/topics", labelKey: "nav.topics", shortLabel: "TP", scope: "project", template: "collection", capability: "project.manage.read" },
      { href: "/manage/hunting", labelKey: "nav.hunting", shortLabel: "HU", scope: "project", template: "work-queue", capability: "hunt.manage" },
      { href: "/manage/skills", labelKey: "nav.skills", shortLabel: "SK", scope: "project", template: "collection", capability: "project.manage.read" },
    ],
  },
];

export const CONSOLE_ROUTES = CONSOLE_NAV_GROUPS.flatMap((group) => group.routes);

export function isActiveRoute(pathname: string, href: string): boolean {
  return href === "/" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}
