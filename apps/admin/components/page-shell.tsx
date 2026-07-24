"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { LanguageSelector } from "@/components/language-selector";
import { useMe } from "@/lib/api/hooks";
import { useT } from "@/lib/i18n/context";

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
  const t = useT();
  const { data: me, isError } = useMe();
  const [project, setProject] = useState("");

  useEffect(() => {
    if (isError) router.replace("/login");
  }, [isError, router]);
  useEffect(() => {
    if (me && !project && me.memberships[0]) setProject(me.memberships[0].project);
  }, [me, project]);

  if (!me) return <main className="p-6 text-sm text-neutral-500">{t("common.loading")}</main>;

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{title}</h1>
          {subtitle ? <p className="text-sm text-neutral-500">{subtitle}</p> : null}
        </div>
        <div className="flex items-center gap-3">
          <select
            aria-label={t("common.project")}
            className="h-9 rounded-md border border-neutral-300 bg-transparent px-2 text-sm dark:border-neutral-700"
            value={project}
            onChange={(event) => setProject(event.target.value)}
          >
            {me.memberships.map((membership) => (
              <option key={membership.project} value={membership.project}>
                {membership.project}
              </option>
            ))}
          </select>
          <LanguageSelector />
          <Link href="/" className="text-sm underline">
            {t("common.back")}
          </Link>
        </div>
      </header>
      {project ? children(project) : <p className="text-sm text-neutral-500">{t("common.selectProject")}</p>}
    </main>
  );
}
