"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { ProjectSelector } from "@/components/project-selector";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { logout } from "@/lib/api/auth";
import { useMe } from "@/lib/api/hooks";

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

        <Card>
          <CardHeader>
            <CardTitle>Observability</CardTitle>
            <CardDescription>Activity, recalls, ingest &amp; approvals</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/observability" className="text-sm underline">
              Open dashboard →
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Living knowledge</CardTitle>
            <CardDescription>Gaps, hunts, disputes &amp; corrections</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/knowledge" className="text-sm underline">
              Open view →
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Review queue</CardTitle>
            <CardDescription>Tables, merges, agent submissions &amp; suggestions</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/review" className="text-sm underline">
              Open queue →
            </Link>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
