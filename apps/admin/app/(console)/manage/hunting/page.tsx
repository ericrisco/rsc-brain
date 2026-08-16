"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { PageShell } from "@/components/page-shell";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type DataColumn } from "@/components/ui/data-table";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAskHunt, useHunts } from "@/lib/api/hooks";
import type { Hunt } from "@/lib/api/types";
import { useI18n } from "@/lib/i18n/context";
import { formatDateTime } from "@/lib/i18n/format";

export default function HuntingPage() {
  const { t } = useI18n();
  return (
    <PageShell title={t("hunting.title")} subtitle={t("hunting.subtitle")}>
      {(project) => <HuntingWorkspace project={project} />}
    </PageShell>
  );
}

function HuntingWorkspace({ project }: { project: string }) {
  const { t, locale } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const params = useSearchParams();
  const openOnly = params.get("open") !== "false";
  const query = useHunts(project, openOnly);
  const ask = useAskHunt(project);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [topics, setTopics] = useState("");
  const [selected, setSelected] = useState<Hunt | null>(null);
  const [error, setError] = useState<string | null>(null);

  function setOpenOnly(value: boolean) {
    const next = new URLSearchParams();
    next.set("open", String(value));
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }

  async function submit() {
    setError(null);
    try {
      await ask.mutateAsync({ question: question.trim(), topics: splitList(topics) });
      setDialogOpen(false);
      setQuestion("");
      setTopics("");
    } catch {
      setError(t("hunting.commandError"));
    }
  }

  const columns: DataColumn<Hunt>[] = [
    { key: "question", label: t("hunting.question"), render: (hunt) => <span className="font-medium">{hunt.question ?? t("hunting.hiddenQuestion")}</span> },
    { key: "state", label: t("hunting.state"), render: (hunt) => <Badge tone={hunt.state.toLowerCase() === "asked" ? "info" : hunt.state.toLowerCase() === "resolved" ? "success" : "neutral"}>{hunt.state}</Badge> },
    { key: "topics", label: t("hunting.topics"), render: (hunt) => hunt.topics.join(", ") || t("common.none") },
    { key: "owner", label: t("hunting.owner"), render: (hunt) => hunt.person_id ? <span className="font-mono text-xs">{hunt.person_id.slice(0, 10)}</span> : t("hunting.noOwner") },
    { key: "deadline", label: t("hunting.deadline"), render: (hunt) => formatDateTime(hunt.expires_at, locale) },
    { key: "inspect", label: t("hunting.actions"), render: (hunt) => <Button size="sm" variant="outline" aria-label={t("hunting.inspectNamed", { id: hunt.id })} onClick={() => setSelected(hunt)}>{t("hunting.inspect")}</Button> },
  ];

  return (
    <div className="space-y-5">
      <section aria-label={t("hunting.operationsRegion")}>
        <Banner title={t("hunting.operationsTitle")} actions={<Button onClick={() => setDialogOpen(true)}>{t("hunting.startManual")}</Button>}>
          {t("hunting.operationsHelp")}
        </Banner>
      </section>
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div><CardTitle>{t("hunting.queue")}</CardTitle><CardDescription>{t("hunting.queueHelp")}</CardDescription></div>
          <label className="flex items-center gap-2 text-sm"><input aria-label={t("hunting.openOnly")} type="checkbox" checked={openOnly} onChange={(event) => setOpenOnly(event.target.checked)} />{t("hunting.openOnly")}</label>
        </CardHeader>
        <CardContent>
          {query.isLoading ? <Skeleton className="h-64 w-full" /> : null}
          {query.isError ? <p role="alert" className="text-sm text-danger">{t("hunting.loadError")}</p> : null}
          {!query.isLoading && !query.isError ? <DataTable caption={t("hunting.table")} columns={columns} rows={query.data?.hunts ?? []} rowKey={(hunt) => hunt.id} emptyTitle={t("hunting.empty")} /> : null}
        </CardContent>
      </Card>

      {selected ? <HuntDetail hunt={selected} /> : null}

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} title={t("hunting.startManual")} description={t("hunting.startHelp")} actions={<Button disabled={!question.trim() || splitList(topics).length === 0 || ask.isPending} onClick={() => void submit()}>{t("hunting.start")}</Button>}>
        <div className="grid gap-4">
          <Field label={t("hunting.question")}><Input aria-label={t("hunting.question")} value={question} onChange={(event) => setQuestion(event.target.value)} /></Field>
          <Field label={t("hunting.topics")}><Input aria-label={t("hunting.topics")} value={topics} onChange={(event) => setTopics(event.target.value)} placeholder={t("hunting.topicsPlaceholder")} /></Field>
        </div>
      </Dialog>
    </div>
  );
}

function HuntDetail({ hunt }: { hunt: Hunt }) {
  const { t, locale } = useI18n();
  const milestones = [
    [t("hunting.created"), hunt.created_at],
    [t("hunting.asked"), hunt.asked_at],
    [t("hunting.answered"), hunt.answered_at],
    [t("hunting.resolved"), hunt.resolved_at],
  ] as const;
  return (
    <Card>
      <CardHeader><CardTitle>{t("hunting.detail")}</CardTitle><CardDescription>{hunt.question ?? t("hunting.hiddenQuestion")}</CardDescription></CardHeader>
      <CardContent>
        <section aria-label={t("hunting.detail")} className="grid gap-3 sm:grid-cols-4">
          {milestones.map(([label, value]) => <div key={label} className="rounded border border-border p-3"><p className="text-xs uppercase tracking-[0.08em] text-text-secondary">{label}</p><p className="mt-1 text-sm">{value ? formatDateTime(value, locale) : t("hunting.notReached")}</p></div>)}
        </section>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1 text-sm font-medium">{label}{children}</label>;
}

function splitList(value: string) {
  return Array.from(new Set(value.split(",").map((item) => item.trim()).filter(Boolean)));
}
