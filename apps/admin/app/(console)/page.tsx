"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { LanguageSelector } from "@/components/language-selector";
import { ProjectSelector } from "@/components/project-selector";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { logout } from "@/lib/api/auth";
import { useMe } from "@/lib/api/hooks";
import { useT } from "@/lib/i18n/context";

export default function DashboardPage() {
  const router = useRouter();
  const t = useT();
  const { data: me, isLoading, isError } = useMe();

  useEffect(() => {
    if (isError) router.replace("/login");
  }, [isError, router]);

  if (isLoading || !me) {
    return <main className="p-6 text-sm text-text-secondary">{t("common.loading")}</main>;
  }

  async function onLogout() {
    await logout();
    router.replace("/login");
  }

  const cards: { href: string; title: string; desc: string }[] = [
    { href: "/connections", title: t("nav.connections"), desc: t("nav.connectionsDesc") },
    { href: "/observability", title: t("nav.observability"), desc: t("nav.observabilityDesc") },
    { href: "/knowledge", title: t("nav.knowledge"), desc: t("nav.knowledgeDesc") },
    { href: "/review", title: t("nav.review"), desc: t("nav.reviewDesc") },
    { href: "/usage", title: t("nav.usage"), desc: t("nav.usageDesc") },
    { href: "/audit", title: t("nav.audit"), desc: t("nav.auditDesc") },
    { href: "/metrics", title: t("nav.metrics"), desc: t("nav.metricsDesc") },
    { href: "/graph", title: t("nav.graph"), desc: t("nav.graphDesc") },
  ];

  return (
    <main className="mx-auto max-w-4xl p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{t("nav.title")}</h1>
          <p className="text-sm text-text-secondary">
            {me.user.email} · {me.user.role}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ProjectSelector me={me} />
          <LanguageSelector />
          <Button variant="outline" size="sm" onClick={onLogout}>
            {t("common.logOut")}
          </Button>
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        {cards.map((card) => (
          <Card key={card.href}>
            <CardHeader>
              <CardTitle>{card.title}</CardTitle>
              <CardDescription>{card.desc}</CardDescription>
            </CardHeader>
            <CardContent>
              <Link href={card.href} className="text-sm underline">
                {card.title} →
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>
    </main>
  );
}
