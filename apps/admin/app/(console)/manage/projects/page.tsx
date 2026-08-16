"use client";

import { useState } from "react";

import { PageShell } from "@/components/page-shell";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type DataColumn } from "@/components/ui/data-table";
import { AlertDialog, Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  useCreateProject,
  useDeleteProject,
  useProjectDeleteImpact,
  useProjects,
  useUpdateProject,
} from "@/lib/api/hooks";
import type { ProjectInventoryItem } from "@/lib/api/types";
import { useI18n } from "@/lib/i18n/context";

export default function ProjectsPage() {
  const { t } = useI18n();
  return (
    <PageShell title={t("projects.title")} subtitle={t("projects.subtitle")}>
      {() => <ProjectsWorkspace />}
    </PageShell>
  );
}

function ProjectsWorkspace() {
  const { t } = useI18n();
  const query = useProjects();
  const create = useCreateProject();
  const update = useUpdateProject();
  const remove = useDeleteProject();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ProjectInventoryItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectInventoryItem | null>(null);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [editName, setEditName] = useState("");
  const [queryLogging, setQueryLogging] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const impact = useProjectDeleteImpact(deleteTarget?.slug ?? null);

  async function createProject() {
    setError(null);
    try {
      await create.mutateAsync({ slug: slug.trim(), name: name.trim(), settings: {} });
      setCreateOpen(false);
      setSlug("");
      setName("");
    } catch {
      setError(t("projects.commandError"));
    }
  }

  async function saveProject() {
    if (!editTarget) return;
    setError(null);
    try {
      await update.mutateAsync({
        slug: editTarget.slug,
        expectedVersion: editTarget.version,
        name: editName.trim(),
        settings: { ...editTarget.settings, query_text_logging: queryLogging },
      });
      setEditTarget(null);
    } catch {
      setError(t("projects.commandError"));
    }
  }

  async function deleteProject() {
    if (!deleteTarget || !impact.data) return;
    setError(null);
    try {
      await remove.mutateAsync({
        slug: deleteTarget.slug,
        expectedVersion: impact.data.version,
        confirm: confirmation,
      });
      setDeleteTarget(null);
      setConfirmation("");
    } catch {
      setError(t("projects.commandError"));
    }
  }

  const columns: DataColumn<ProjectInventoryItem>[] = [
    {
      key: "project",
      label: t("projects.project"),
      render: (project) => (
        <div><p className="font-medium">{project.name}</p><p className="font-mono text-xs text-text-secondary">{project.slug}</p></div>
      ),
    },
    { key: "status", label: t("projects.status"), render: (project) => <Badge tone={project.status === "active" ? "success" : "neutral"}>{project.status}</Badge> },
    { key: "members", label: t("projects.members"), align: "right", render: (project) => project.membership_count },
    { key: "version", label: t("projects.version"), align: "right", render: (project) => `v${project.version}` },
    {
      key: "actions",
      label: t("projects.actions"),
      render: (project) => (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" aria-label={t("projects.editNamed", { name: project.name })} onClick={() => {
            setEditTarget(project);
            setEditName(project.name);
            setQueryLogging(project.settings.query_text_logging === true);
          }}>{t("projects.edit")}</Button>
          <Button size="sm" variant="destructive" aria-label={t("projects.deleteNamed", { name: project.name })} onClick={() => {
            setDeleteTarget(project);
            setConfirmation("");
          }}>{t("projects.delete")}</Button>
        </div>
      ),
    },
  ];

  const expectedConfirmation = impact.data?.confirmation ?? "";

  return (
    <div className="space-y-5">
      <section aria-label={t("projects.inventoryRegion")}>
        <Banner title={t("projects.platformScope")} tone="info" actions={<Button onClick={() => setCreateOpen(true)}>{t("projects.create")}</Button>}>
          {t("projects.platformScopeHelp")}
        </Banner>
      </section>
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      <Card>
        <CardHeader>
          <CardTitle>{t("projects.inventory")}</CardTitle>
          <CardDescription>{t("projects.inventoryHelp")}</CardDescription>
        </CardHeader>
        <CardContent>
          {query.isError ? <p role="alert" className="text-sm text-danger">{t("projects.loadError")}</p> : null}
          {!query.isLoading && !query.isError ? (
            <DataTable caption={t("projects.table")} columns={columns} rows={query.data?.projects ?? []} rowKey={(project) => project.id} emptyTitle={t("projects.empty")} />
          ) : null}
        </CardContent>
      </Card>

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t("projects.create")}
        description={t("projects.createHelp")}
        actions={<Button disabled={!slug.trim() || !name.trim() || create.isPending} onClick={() => void createProject()}>{t("projects.create")}</Button>}
      >
        <div className="grid gap-4">
          <Field label={t("projects.slug")}><Input aria-label={t("projects.slug")} value={slug} onChange={(event) => setSlug(event.target.value)} /></Field>
          <Field label={t("projects.name")}><Input aria-label={t("projects.name")} value={name} onChange={(event) => setName(event.target.value)} /></Field>
        </div>
      </Dialog>

      <Dialog
        open={!!editTarget}
        onClose={() => setEditTarget(null)}
        title={t("projects.editProject")}
        description={editTarget ? t("projects.versionedHelp", { version: editTarget.version }) : undefined}
        actions={<Button disabled={!editName.trim() || update.isPending} onClick={() => void saveProject()}>{t("projects.save")}</Button>}
      >
        <div className="grid gap-4">
          <Field label={t("projects.name")}><Input aria-label={t("projects.name")} value={editName} onChange={(event) => setEditName(event.target.value)} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={queryLogging} onChange={(event) => setQueryLogging(event.target.checked)} />{t("projects.queryLogging")}</label>
        </div>
      </Dialog>

      <AlertDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={t("projects.deleteProject")}
        description={deleteTarget ? t("projects.deleteHelp", { name: deleteTarget.name }) : undefined}
        actions={(
          <Button
            variant="destructive"
            disabled={!impact.data?.can_delete || confirmation !== expectedConfirmation || remove.isPending}
            onClick={() => void deleteProject()}
          >
            {t("projects.deleteNow")}
          </Button>
        )}
      >
        <div className="space-y-4">
          {impact.isLoading ? <p className="text-sm text-text-secondary">{t("common.loading")}</p> : null}
          {impact.data ? (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {Object.entries(impact.data.dependencies).map(([kind, count]) => (
                  <div key={kind} className="rounded border border-border bg-surface-subtle p-3 text-sm"><strong>{count}</strong> {kind}</div>
                ))}
              </div>
              {!impact.data.can_delete ? <Banner title={t("projects.protected")} tone="warning">{t("projects.protectedHelp")}</Banner> : null}
              <Field label={t("projects.confirmLabel", { value: impact.data.confirmation })}>
                <Input aria-label={t("projects.confirmLabel", { value: impact.data.confirmation })} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" />
              </Field>
            </>
          ) : null}
        </div>
      </AlertDialog>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1 text-sm font-medium">{label}{children}</label>;
}
