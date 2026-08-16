"use client";

import { useState } from "react";

import { PageShell } from "@/components/page-shell";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type DataColumn } from "@/components/ui/data-table";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useCreateTopic, useGrantTopic, useRevokeTopic, useTopics, useUpdateTopic, useUsers } from "@/lib/api/hooks";
import type { TopicState } from "@/lib/api/types";
import { useI18n } from "@/lib/i18n/context";

export default function TopicsPage() {
  const { t } = useI18n();
  return (
    <PageShell title={t("topics.title")} subtitle={t("topics.subtitle")}>
      {(project) => <TopicsWorkspace project={project} />}
    </PageShell>
  );
}

function TopicsWorkspace({ project }: { project: string }) {
  const { t } = useI18n();
  const query = useTopics(project);
  const users = useUsers(project);
  const create = useCreateTopic(project);
  const update = useUpdateTopic(project);
  const grant = useGrantTopic(project);
  const revoke = useRevokeTopic(project);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<TopicState | null>(null);
  const [authorityTarget, setAuthorityTarget] = useState<TopicState | null>(null);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [sensitivity, setSensitivity] = useState("0");
  const [retention, setRetention] = useState("");
  const [userId, setUserId] = useState("");
  const [error, setError] = useState<string | null>(null);

  function setFromTopic(topic: TopicState) {
    setEditTarget(topic);
    setName(topic.name);
    setSensitivity(String(topic.sensitivity));
    setRetention(topic.hard_window_days === null ? "" : String(topic.hard_window_days));
  }

  function resetCreate() {
    setSlug("");
    setName("");
    setSensitivity("0");
    setRetention("");
  }

  async function submitCreate() {
    setError(null);
    try {
      await create.mutateAsync({
        slug: slug.trim(),
        name: name.trim(),
        sensitivity: Number(sensitivity),
        hardWindowDays: retention ? Number(retention) : null,
      });
      setCreateOpen(false);
      resetCreate();
    } catch {
      setError(t("topics.commandError"));
    }
  }

  async function submitEdit() {
    if (!editTarget) return;
    setError(null);
    try {
      await update.mutateAsync({
        slug: editTarget.slug,
        expectedVersion: editTarget.version,
        name: name.trim(),
        sensitivity: Number(sensitivity),
        hardWindowDays: retention ? Number(retention) : null,
      });
      setEditTarget(null);
    } catch {
      setError(t("topics.commandError"));
    }
  }

  async function changeAuthority(action: "grant" | "revoke") {
    if (!authorityTarget || !userId.trim()) return;
    setError(null);
    try {
      const input = { slug: authorityTarget.slug, userId: userId.trim() };
      if (action === "grant") await grant.mutateAsync(input);
      else await revoke.mutateAsync(input);
      setAuthorityTarget(null);
    } catch {
      setError(t("topics.commandError"));
    }
  }

  const columns: DataColumn<TopicState>[] = [
    { key: "topic", label: t("topics.topic"), render: (topic) => <div><p className="font-medium">{topic.name}</p><p className="font-mono text-xs text-text-secondary">{topic.slug}</p></div> },
    { key: "sensitivity", label: t("topics.sensitivity"), render: (topic) => <Badge tone={topic.sensitivity >= 3 ? "warning" : "neutral"}>{topic.sensitivity} / 10</Badge> },
    { key: "retention", label: t("topics.retention"), render: (topic) => topic.hard_window_days === null ? t("topics.noHardLimit") : t("topics.days", { days: topic.hard_window_days }) },
    { key: "version", label: t("topics.version"), align: "right", render: (topic) => `v${topic.version}` },
    {
      key: "actions",
      label: t("topics.actions"),
      render: (topic) => (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" aria-label={t("topics.editNamed", { name: topic.name })} onClick={() => setFromTopic(topic)}>{t("topics.edit")}</Button>
          <Button size="sm" variant="outline" aria-label={t("topics.authorityNamed", { name: topic.name })} onClick={() => { setAuthorityTarget(topic); setUserId(""); }}>{t("topics.authority")}</Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <section aria-label={t("topics.boundaryRegion")}>
        <Banner title={t("topics.boundaryTitle")} tone="warning" actions={<Button onClick={() => { resetCreate(); setCreateOpen(true); }}>{t("topics.create")}</Button>}>
          {t("topics.boundaryHelp")}
        </Banner>
      </section>
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      <Card>
        <CardHeader><CardTitle>{t("topics.inventory")}</CardTitle><CardDescription>{t("topics.inventoryHelp")}</CardDescription></CardHeader>
        <CardContent>
          {query.isLoading ? <Skeleton className="h-64 w-full" /> : null}
          {query.isError ? <p role="alert" className="text-sm text-danger">{t("topics.loadError")}</p> : null}
          {!query.isLoading && !query.isError ? <DataTable caption={t("topics.table")} columns={columns} rows={query.data?.topics ?? []} rowKey={(topic) => topic.id} emptyTitle={t("topics.empty")} /> : null}
        </CardContent>
      </Card>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title={t("topics.create")} description={t("topics.createHelp")} actions={<Button disabled={!slug.trim() || !name.trim() || create.isPending} onClick={() => void submitCreate()}>{t("topics.create")}</Button>}>
        <TopicFields slug={slug} onSlug={setSlug} name={name} onName={setName} sensitivity={sensitivity} onSensitivity={setSensitivity} retention={retention} onRetention={setRetention} includeSlug />
      </Dialog>
      <Dialog open={!!editTarget} onClose={() => setEditTarget(null)} title={t("topics.editTopic")} description={editTarget ? t("topics.versionedHelp", { version: editTarget.version }) : undefined} actions={<Button disabled={!name.trim() || update.isPending} onClick={() => void submitEdit()}>{t("topics.save")}</Button>}>
        <TopicFields slug="" onSlug={() => undefined} name={name} onName={setName} sensitivity={sensitivity} onSensitivity={setSensitivity} retention={retention} onRetention={setRetention} />
      </Dialog>
      <Dialog open={!!authorityTarget} onClose={() => setAuthorityTarget(null)} title={t("topics.manageAuthority")} description={authorityTarget ? t("topics.authorityHelp", { topic: authorityTarget.slug }) : undefined} actions={(
        <>
          <Button variant="outline" disabled={!authorityTarget || !userId.trim() || revoke.isPending} onClick={() => void changeAuthority("revoke")}>{t("topics.revoke")}</Button>
          <Button disabled={!authorityTarget || !userId.trim() || grant.isPending} onClick={() => void changeAuthority("grant")}>{t("topics.grant")}</Button>
        </>
      )}>
        <Field label={t("topics.user")}>
          <Select aria-label={t("topics.user")} value={userId} disabled={users.isLoading || users.isError} onChange={(event) => setUserId(event.target.value)}>
            <option value="">{users.isError ? t("topics.usersUnavailable") : users.isLoading ? t("common.loading") : t("topics.chooseUser")}</option>
            {(users.data?.items ?? []).map((user) => <option key={user.id} value={user.id}>{user.email}</option>)}
          </Select>
        </Field>
      </Dialog>
    </div>
  );
}

function TopicFields({ slug, onSlug, name, onName, sensitivity, onSensitivity, retention, onRetention, includeSlug = false }: {
  slug: string;
  onSlug: (value: string) => void;
  name: string;
  onName: (value: string) => void;
  sensitivity: string;
  onSensitivity: (value: string) => void;
  retention: string;
  onRetention: (value: string) => void;
  includeSlug?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {includeSlug ? <Field label={t("topics.slug")}><Input aria-label={t("topics.slug")} value={slug} onChange={(event) => onSlug(event.target.value)} /></Field> : null}
      <Field label={t("topics.name")}><Input aria-label={t("topics.name")} value={name} onChange={(event) => onName(event.target.value)} /></Field>
      <Field label={t("topics.sensitivity")}><Input aria-label={t("topics.sensitivity")} type="number" min={0} max={10} value={sensitivity} onChange={(event) => onSensitivity(event.target.value)} /></Field>
      <Field label={t("topics.hardRetention")}><Input aria-label={t("topics.hardRetention")} type="number" min={1} value={retention} onChange={(event) => onRetention(event.target.value)} placeholder={t("topics.optional")} /></Field>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1 text-sm font-medium">{label}{children}</label>;
}
