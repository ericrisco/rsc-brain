"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { PageShell } from "@/components/page-shell";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type DataColumn } from "@/components/ui/data-table";
import { AlertDialog, Dialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useArchiveSkill, useCreateSkill, useSkills, useValidateSkill } from "@/lib/api/hooks";
import type { Skill } from "@/lib/api/types";
import { useI18n } from "@/lib/i18n/context";

const TEMPLATE = `---
okf_version: "0.1"
kind: skill
title: New skill
description: Describe the operator outcome.
rsc_brain_slug: new-skill
rsc_brain_tags:
  - general
rsc_brain_depends_on: []
rsc_brain_state: proposed
rsc_brain_version: 1
---
# Instructions

Describe when and how this skill should run.
`;

export default function SkillsPage() {
  const { t } = useI18n();
  return (
    <PageShell title={t("skills.title")} subtitle={t("skills.subtitle")}>
      {(project) => <SkillsWorkspace project={project} />}
    </PageShell>
  );
}

function SkillsWorkspace({ project }: { project: string }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const params = useSearchParams();
  const selectedState = params.get("state") || "all";
  const query = useSkills(project, selectedState === "all" ? undefined : selectedState);
  const create = useCreateSkill(project);
  const validate = useValidateSkill(project);
  const archive = useArchiveSkill(project);
  const [createOpen, setCreateOpen] = useState(false);
  const [markdown, setMarkdown] = useState(TEMPLATE);
  const [archiveTarget, setArchiveTarget] = useState<Skill | null>(null);
  const [error, setError] = useState<string | null>(null);

  function updateState(value: string) {
    const next = new URLSearchParams();
    next.set("state", value);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }

  async function submitCreate() {
    setError(null);
    try {
      await create.mutateAsync(markdown);
      setCreateOpen(false);
      setMarkdown(TEMPLATE);
    } catch {
      setError(t("skills.commandError"));
    }
  }

  const columns: DataColumn<Skill>[] = [
    { key: "skill", label: t("skills.skill"), render: (skill) => <div><p className="font-medium">{skill.title}</p><p className="font-mono text-xs text-text-secondary">{skill.slug}</p></div> },
    { key: "status", label: t("skills.status"), render: (skill) => <Badge tone={skill.status === "active" ? "success" : skill.status === "proposed" ? "info" : "neutral"}>{skill.status}</Badge> },
    { key: "freshness", label: t("skills.freshness"), render: (skill) => <Badge tone={skill.stale ? "warning" : "success"}>{skill.stale ? t("skills.stale") : t("skills.current")}</Badge> },
    { key: "dependencies", label: t("skills.dependencies"), render: (skill) => skill.depends_on.length ? `${skill.depends_on.length}` : t("common.none") },
    { key: "version", label: t("skills.version"), align: "right", render: (skill) => `v${skill.version}` },
    {
      key: "actions",
      label: t("skills.actions"),
      render: (skill) => (
        <div className="flex flex-wrap gap-2">
          {skill.status === "proposed" ? <Button size="sm" aria-label={t("skills.validateNamed", { name: skill.title })} disabled={validate.isPending} onClick={async () => {
            setError(null);
            try { await validate.mutateAsync({ slug: skill.slug, expectedVersion: skill.version }); } catch { setError(t("skills.commandError")); }
          }}>{t("skills.validate")}</Button> : null}
          {skill.status !== "archived" ? <Button size="sm" variant="outline" aria-label={t("skills.archiveNamed", { name: skill.title })} onClick={() => setArchiveTarget(skill)}>{t("skills.archive")}</Button> : null}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <section aria-label={t("skills.governanceRegion")}>
        <Banner title={t("skills.governanceTitle")} actions={<Button onClick={() => setCreateOpen(true)}>{t("skills.create")}</Button>}>
          {t("skills.governanceHelp")}
        </Banner>
      </section>
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div><CardTitle>{t("skills.inventory")}</CardTitle><CardDescription>{t("skills.inventoryHelp")}</CardDescription></div>
          <label className="grid gap-1 text-xs font-medium text-text-secondary">{t("skills.state")}<Select aria-label={t("skills.state")} value={selectedState} onChange={(event) => updateState(event.target.value)}><option value="all">{t("common.all")}</option><option value="proposed">proposed</option><option value="active">active</option><option value="archived">archived</option></Select></label>
        </CardHeader>
        <CardContent>
          {query.isLoading ? <Skeleton className="h-64 w-full" /> : null}
          {query.isError ? <p role="alert" className="text-sm text-danger">{t("skills.loadError")}</p> : null}
          {!query.isLoading && !query.isError ? <DataTable caption={t("skills.table")} columns={columns} rows={query.data?.skills ?? []} rowKey={(skill) => skill.slug} emptyTitle={t("skills.empty")} /> : null}
        </CardContent>
      </Card>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title={t("skills.create")} description={t("skills.createHelp")} actions={<Button disabled={!markdown.trim() || create.isPending} onClick={() => void submitCreate()}>{t("skills.createProposed")}</Button>}>
        <label className="grid gap-2 text-sm font-medium">{t("skills.markdown")}
          <textarea aria-label={t("skills.markdown")} className="min-h-80 w-full resize-y rounded-[var(--radius-panel)] border border-border-strong bg-surface p-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" value={markdown} onChange={(event) => setMarkdown(event.target.value)} spellCheck={false} />
        </label>
      </Dialog>

      <AlertDialog open={!!archiveTarget} onClose={() => setArchiveTarget(null)} title={t("skills.archiveSkill")} description={archiveTarget ? t("skills.archiveHelp", { name: archiveTarget.title }) : undefined} actions={<Button variant="destructive" disabled={!archiveTarget || archive.isPending} onClick={async () => {
        if (!archiveTarget) return;
        setError(null);
        try { await archive.mutateAsync({ slug: archiveTarget.slug, expectedVersion: archiveTarget.version }); setArchiveTarget(null); } catch { setError(t("skills.commandError")); }
      }}>{t("skills.archiveNow")}</Button>} />
    </div>
  );
}
