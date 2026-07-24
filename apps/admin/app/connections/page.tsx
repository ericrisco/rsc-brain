"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCreatePat, useMe, usePats, useRevokePat } from "@/lib/api/hooks";
import { useT } from "@/lib/i18n/context";

export default function ConnectionsPage() {
  const t = useT();
  const router = useRouter();
  const { data: me, isError } = useMe();
  const { data: patList } = usePats();
  const createPat = useCreatePat();
  const revokePat = useRevokePat();

  const [project, setProject] = useState("");
  const [name, setName] = useState("");
  const [freshToken, setFreshToken] = useState<string | null>(null);

  useEffect(() => {
    if (isError) router.replace("/login");
  }, [isError, router]);

  useEffect(() => {
    if (me && !project && me.memberships[0]) setProject(me.memberships[0].project);
  }, [me, project]);

  if (!me) {
    return <main className="p-6 text-sm text-neutral-500">{t("common.loading")}</main>;
  }

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    const created = await createPat.mutateAsync({ project, name: name || undefined });
    setFreshToken(created.token);
    setName("");
  }

  return (
    <main className="mx-auto max-w-3xl p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{t("connections.title")}</h1>
          <p className="text-sm text-neutral-500">{t("connections.subtitle")}</p>
        </div>
        <Link href="/" className="text-sm underline">
          ← {t("connections.back")}
        </Link>
      </header>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t("connections.createTitle")}</CardTitle>
          <CardDescription>{t("connections.createDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreate} className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="project">{t("common.project")}</Label>
              <select
                id="project"
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
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="name">{t("connections.name")}</Label>
              <Input
                id="name"
                value={name}
                placeholder={t("connections.namePlaceholder")}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <Button type="submit" disabled={createPat.isPending || !project}>
              {t("connections.create")}
            </Button>
          </form>

          {freshToken ? (
            <div className="mt-4 rounded-md border border-amber-400 bg-amber-50 p-3 text-sm dark:bg-amber-950">
              <p className="mb-1 font-medium">{t("connections.copyNow")}</p>
              <code className="break-all">{freshToken}</code>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("connections.activeTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-2">
            {(patList?.pats ?? []).map((pat) => (
              <li
                key={pat.id}
                className="flex items-center justify-between rounded-md border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-800"
              >
                <span>
                  <span className="font-medium">{pat.name ?? t("connections.unnamed")}</span> ·{" "}
                  {pat.project}
                  {pat.revoked ? ` · ${t("connections.revoked")}` : ""}
                </span>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={pat.revoked || revokePat.isPending}
                  onClick={() => revokePat.mutate(pat.id)}
                >
                  {t("connections.revoke")}
                </Button>
              </li>
            ))}
            {(patList?.pats ?? []).length === 0 ? (
              <li className="text-sm text-neutral-500">{t("connections.empty")}</li>
            ) : null}
          </ul>
        </CardContent>
      </Card>

      <Card className="mt-6 opacity-60">
        <CardHeader>
          <CardTitle>{t("connections.oauthTitle")}</CardTitle>
          <CardDescription>{t("connections.oauthDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-neutral-500">{t("connections.oauthBody")}</p>
        </CardContent>
      </Card>
    </main>
  );
}
