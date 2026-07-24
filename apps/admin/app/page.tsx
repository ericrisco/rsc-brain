"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { ProjectSelector } from "@/components/project-selector";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { logout } from "@/lib/api/auth";
import { useMe } from "@/lib/api/hooks";

function EmptyCard({ title, note }: { title: string; note: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>Coming soon</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-neutral-500">{note}</p>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const { data: me, isLoading, isError } = useMe();

  useEffect(() => {
    if (isError) router.replace("/login");
  }, [isError, router]);

  if (isLoading || !me) {
    return <main className="p-6 text-sm text-neutral-500">Loading…</main>;
  }

  async function onLogout() {
    await logout();
    router.replace("/login");
  }

  return (
    <main className="mx-auto max-w-4xl p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">rsc-brain console</h1>
          <p className="text-sm text-neutral-500">
            {me.user.email} · {me.user.role}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ProjectSelector me={me} />
          <Button variant="outline" size="sm" onClick={onLogout}>
            Log out
          </Button>
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>My connections</CardTitle>
            <CardDescription>Personal access tokens</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/connections" className="text-sm underline">
              Manage tokens →
            </Link>
          </CardContent>
        </Card>

        {me.is_owner ? (
          <Card>
            <CardHeader>
              <CardTitle>Global view</CardTitle>
              <CardDescription>Owner only</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-neutral-500">All projects — arrives in v0.2 (E13.2).</p>
            </CardContent>
          </Card>
        ) : null}

        <EmptyCard title="Dashboard" note="Observability arrives in v0.2 (E13.2)." />
        <EmptyCard title="Ingestion & approvals" note="Approval queue arrives in v0.2 (E13.2)." />
      </div>
    </main>
  );
}
