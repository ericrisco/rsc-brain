"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { PageShell } from "@/components/page-shell";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { DataTable, type DataColumn } from "@/components/ui/data-table";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs } from "@/components/ui/tabs";
import {
  useActivity,
  useApproveDoc,
  useHealth,
  useIngest,
  useMe,
  usePendingDocs,
  useRecalls,
  useRejectDoc,
} from "@/lib/api/hooks";
import type { IngestError, IngestRun, PendingDoc, RecallRow } from "@/lib/api/types";
import { useI18n } from "@/lib/i18n/context";
import { formatDateTime, formatNumber } from "@/lib/i18n/format";

const TAB_VALUES = ["overview", "recalls", "ingest", "approvals"] as const;
type ObservabilityTab = (typeof TAB_VALUES)[number];

export default function ObservabilityPage() {
  const { t } = useI18n();
  return (
    <PageShell title={t("observability.title")} subtitle={t("observability.subtitle")}>
      {(project) => <ObservabilitySurface project={project} />}
    </PageShell>
  );
}

function ObservabilitySurface({ project }: { project: string }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const [paused, setPaused] = useState(false);
  const session = useMe();
  const membership = session.data?.memberships.find((item) => item.project === project);
  const canReview = membership?.role === "project-admin";
  const activeTab: ObservabilityTab =
    TAB_VALUES.includes(requestedTab as ObservabilityTab) &&
    (requestedTab !== "approvals" || canReview)
      ? (requestedTab as ObservabilityTab)
      : "overview";
  const pending = usePendingDocs(project, { paused, enabled: canReview });

  const changeTab = (tab: string) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("tab", tab);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  const tabs = [
    { value: "overview", label: t("observability.overviewTab") },
    { value: "recalls", label: t("observability.recallsTab") },
    { value: "ingest", label: t("observability.ingestTab") },
    ...(canReview
      ? [
          {
            value: "approvals",
            label: t("observability.approvalsTab"),
            count: pending.data?.documents.length ?? 0,
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-y border-border py-3">
        <div className="flex items-center gap-3 text-sm">
          <span
            className={`size-2 rounded-full ${paused ? "bg-warning" : "bg-success"}`}
            aria-hidden="true"
          />
          <span className="font-medium">{t("observability.liveProject", { project })}</span>
          <span className="text-text-secondary">
            {paused ? t("observability.paused") : t("observability.refreshCadence")}
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={() => setPaused((current) => !current)}>
          {paused ? t("observability.resume") : t("observability.pause")}
        </Button>
      </div>

      <Tabs
        items={tabs}
        value={activeTab}
        onValueChange={changeTab}
        label={t("observability.tabsLabel")}
      >
        {activeTab === "overview" ? (
          <OperationalOverview project={project} paused={paused} />
        ) : null}
        {activeTab === "recalls" ? (
          <RecallStream project={project} paused={paused} />
        ) : null}
        {activeTab === "ingest" ? <IngestWorkspace project={project} paused={paused} /> : null}
        {activeTab === "approvals" ? (
          <ApprovalQueue project={project} query={pending} />
        ) : null}
      </Tabs>
    </div>
  );
}

type QueryResult<Data> = {
  data?: Data;
  isLoading: boolean;
  isError: boolean;
};

function OperationalOverview({
  project,
  paused,
}: {
  project: string;
  paused: boolean;
}) {
  const { t, locale } = useI18n();
  const activity = useActivity(project, { paused });
  const health = useHealth(project, { paused });
  if (activity.isLoading || health.isLoading) return <Skeleton className="h-64 w-full" />;
  if (activity.isError || health.isError) {
    return (
      <Banner tone="danger" title={t("observability.loadError")}>
        {t("common.tryAgain")}
      </Banner>
    );
  }
  if (!activity.data || !health.data) return null;

  const signals = [
    {
      label: t("observability.recalls"),
      value: formatNumber(activity.data.recalls, locale),
      detail: t("observability.authorizedEvents"),
    },
    {
      label: t("observability.abstainedDenied"),
      value: formatNumber(activity.data.denied, locale),
      detail: t("observability.policyOutcomes"),
    },
    {
      label: t("observability.activePrincipals"),
      value: formatNumber(activity.data.active_principals, locale),
      detail: t("observability.distinctPrincipals"),
    },
    {
      label: t("observability.p95Latency"),
      value:
        activity.data.p95_duration_ms === null
          ? "—"
          : `${formatNumber(activity.data.p95_duration_ms, locale)} ms`,
      detail: t("observability.recallLatency"),
    },
  ];

  return (
    <div className="space-y-8">
      <section aria-labelledby="operational-signal-title">
        <div className="mb-4">
          <p className="font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-interactive">
            {t("observability.currentWindow")}
          </p>
          <h2 id="operational-signal-title" className="mt-1 text-xl font-semibold">
            {t("observability.operationalSignal")}
          </h2>
        </div>
        <dl className="grid divide-y divide-border border-y border-border sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4">
          {signals.map((signal) => (
            <div
              key={signal.label}
              className="px-4 py-5 sm:border-r sm:border-border sm:last:border-r-0"
            >
              <dt className="text-xs text-text-secondary">{signal.label}</dt>
              <dd className="mt-2">
                <span className="font-mono text-2xl font-medium tabular-nums">{signal.value}</span>
                <span className="mt-1 block text-xs text-text-tertiary">{signal.detail}</span>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section
        aria-labelledby="service-state-title"
        className="grid gap-5 lg:grid-cols-[15rem_1fr]"
      >
        <div>
          <h2 id="service-state-title" className="text-lg font-semibold">
            {t("observability.serviceState")}
          </h2>
          <p className="mt-1 text-sm text-text-secondary">
            {t("observability.serviceStateHelp")}
          </p>
        </div>
        <dl className="divide-y divide-border border-y border-border">
          <StateRow
            label={t("observability.database")}
            value={health.data.database}
            tone={health.data.database === "ok" ? "success" : "danger"}
          />
          <StateRow
            label={t("observability.pendingApproval")}
            value={formatNumber(health.data.pending_approval, locale)}
            tone={health.data.pending_approval > 0 ? "warning" : "success"}
          />
          <StateRow
            label={t("observability.ingestErrors")}
            value={formatNumber(health.data.ingest_errors, locale)}
            tone={health.data.ingest_errors > 0 ? "danger" : "success"}
          />
        </dl>
      </section>
    </div>
  );
}

function StateRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "success" | "warning" | "danger";
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-3">
      <dt className="text-sm text-text-secondary">{label}</dt>
      <dd>
        <Badge tone={tone}>{value}</Badge>
      </dd>
    </div>
  );
}

function RecallStream({
  project,
  paused,
}: {
  project: string;
  paused: boolean;
}) {
  const { t, locale } = useI18n();
  const [principal, setPrincipal] = useState("");
  const query = useRecalls(project, principal ? { principal_type: principal } : {}, { paused });
  const rows = query.data?.items ?? [];
  const columns: DataColumn<RecallRow>[] = [
    {
      key: "time",
      label: t("observability.time"),
      render: (row) => formatDateTime(row.ts, locale),
    },
    {
      key: "query",
      label: t("observability.query"),
      render: (row) => (
        <span className="font-mono text-xs">{row.query_text ?? row.query_hash ?? "—"}</span>
      ),
    },
    {
      key: "principal",
      label: t("observability.principal"),
      render: (row) => row.principal_type ?? "—",
    },
    {
      key: "results",
      label: t("observability.results"),
      align: "right",
      render: (row) => (
        <span data-testid="recall-result-count">{row.result_count ?? "—"}</span>
      ),
    },
    {
      key: "duration",
      label: t("observability.duration"),
      align: "right",
      render: (row) => (
        <span data-testid="recall-duration">
          {row.duration_ms === null ? "—" : `${row.duration_ms} ms`}
        </span>
      ),
    },
    {
      key: "decision",
      label: t("observability.decision"),
      render: (row) => (
        <Badge tone={row.denied ? "danger" : "success"}>
          {row.denied ? t("observability.denied") : t("observability.allowed")}
        </Badge>
      ),
    },
  ];

  return (
    <section aria-labelledby="recall-stream-title" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 id="recall-stream-title" className="text-xl font-semibold">
            {t("observability.recallStream")}
          </h2>
          <p className="mt-1 text-sm text-text-secondary">
            {t("observability.recallPrivacy")}
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="principal-filter">{t("observability.principalFilter")}</Label>
          <Select
            id="principal-filter"
            value={principal}
            onChange={(event) => setPrincipal(event.target.value)}
          >
            <option value="">{t("observability.allPrincipals")}</option>
            <option value="human">{t("observability.humans")}</option>
            <option value="agent">{t("observability.agents")}</option>
          </Select>
        </div>
      </div>
      {query.isLoading ? <Skeleton className="h-56 w-full" /> : null}
      {query.isError ? (
        <Banner tone="danger" title={t("observability.loadError")}>
          {t("common.tryAgain")}
        </Banner>
      ) : null}
      {!query.isLoading && !query.isError ? (
        <DataTable
          caption={t("observability.recallStream")}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          emptyTitle={t("observability.noQueries")}
          emptyDescription={t("observability.noQueriesHelp")}
        />
      ) : null}
    </section>
  );
}

function IngestWorkspace({ project, paused }: { project: string; paused: boolean }) {
  const { t } = useI18n();
  const query = useIngest(project, { paused });
  if (query.isLoading) return <Skeleton className="h-64 w-full" />;
  if (query.isError) {
    return (
      <Banner tone="danger" title={t("observability.loadError")}>
        {t("common.tryAgain")}
      </Banner>
    );
  }
  const runs = query.data?.runs ?? [];
  const errors = query.data?.errors ?? [];
  const runColumns: DataColumn<IngestRun>[] = [
    {
      key: "document",
      label: t("observability.document"),
      render: (run) => <span className="font-mono text-xs">{run.document_id}</span>,
    },
    {
      key: "phase",
      label: t("observability.phase"),
      render: (run) => <Badge tone={run.error ? "danger" : "info"}>{run.phase}</Badge>,
    },
    {
      key: "stages",
      label: t("observability.completedStages"),
      render: (run) => run.completed_stages.join(" · ") || "—",
    },
    {
      key: "chunks",
      label: t("observability.chunks"),
      align: "right",
      render: (run) => run.chunks_created,
    },
    {
      key: "claims",
      label: t("observability.claims"),
      align: "right",
      render: (run) => run.claims_generated,
    },
  ];
  const errorColumns: DataColumn<IngestError>[] = [
    {
      key: "document",
      label: t("observability.document"),
      render: (error) => error.document_id ?? "—",
    },
    { key: "stage", label: t("observability.stage"), render: (error) => error.stage },
    { key: "error", label: t("observability.error"), render: (error) => error.error },
  ];
  return (
    <div className="space-y-8">
      <section aria-labelledby="ingest-runs-title">
        <h2 id="ingest-runs-title" className="mb-4 text-xl font-semibold">
          {t("observability.ingestRuns")}
        </h2>
        <DataTable
          caption={t("observability.ingestRuns")}
          columns={runColumns}
          rows={runs}
          rowKey={(run) => run.document_id}
          emptyTitle={t("observability.noIngestRuns")}
        />
      </section>
      <section aria-labelledby="ingest-errors-title">
        <h2 id="ingest-errors-title" className="mb-4 text-xl font-semibold">
          {t("observability.extractionErrors")}
        </h2>
        <DataTable
          caption={t("observability.extractionErrors")}
          columns={errorColumns}
          rows={errors}
          rowKey={(error) =>
            `${error.document_id ?? "unknown"}:${error.stage}:${error.error}`
          }
          emptyTitle={t("observability.noIngestErrors")}
        />
      </section>
    </div>
  );
}

function ApprovalQueue({
  project,
  query,
}: {
  project: string;
  query: QueryResult<{ documents: PendingDoc[] }>;
}) {
  const { t } = useI18n();
  const approve = useApproveDoc(project);
  const reject = useRejectDoc(project);
  const [rejectTarget, setRejectTarget] = useState<PendingDoc | null>(null);
  const [reason, setReason] = useState("");
  const [mutationError, setMutationError] = useState(false);

  if (query.isLoading) return <Skeleton className="h-64 w-full" />;
  if (query.isError) {
    return (
      <Banner tone="danger" title={t("observability.loadError")}>
        {t("common.tryAgain")}
      </Banner>
    );
  }
  const documents = query.data?.documents ?? [];

  async function onReject() {
    if (!rejectTarget) return;
    setMutationError(false);
    try {
      await reject.mutateAsync({ documentId: rejectTarget.document_id, reason: reason.trim() });
      setRejectTarget(null);
      setReason("");
    } catch {
      setMutationError(true);
    }
  }

  return (
    <section aria-labelledby="approval-queue-title" className="space-y-4">
      <div>
        <h2 id="approval-queue-title" className="text-xl font-semibold">
          {t("observability.approvalQueue")}
        </h2>
        <p className="mt-1 text-sm text-text-secondary">{t("observability.approvalHelp")}</p>
      </div>
      {mutationError ? (
        <Banner tone="danger" title={t("observability.decisionError")}>
          {t("common.tryAgain")}
        </Banner>
      ) : null}
      {documents.length === 0 ? (
        <p className="border-y border-border py-8 text-sm text-text-secondary">
          {t("observability.nothingPending")}
        </p>
      ) : (
        <ol className="divide-y divide-border border-y border-border">
          {documents.map((document) => (
            <PendingRow
              key={document.document_id}
              document={document}
              pending={approve.isPending || reject.isPending}
              onApprove={async (tags) => {
                setMutationError(false);
                try {
                  await approve.mutateAsync({ documentId: document.document_id, tags });
                } catch {
                  setMutationError(true);
                }
              }}
              onReject={() => {
                setReason("");
                setRejectTarget(document);
              }}
            />
          ))}
        </ol>
      )}
      <Dialog
        open={rejectTarget !== null}
        onClose={() => setRejectTarget(null)}
        title={t("observability.rejectDialogTitle")}
        cancelLabel={t("common.cancel")}
        description={
          rejectTarget
            ? t("observability.rejectDialogDescription", {
                title: rejectTarget.title ?? rejectTarget.document_id,
              })
            : undefined
        }
        destructive
        actions={
          <Button
            variant="destructive"
            disabled={!reason.trim() || reject.isPending}
            onClick={onReject}
          >
            {t("observability.rejectDocument")}
          </Button>
        }
      >
        <div className="grid gap-2">
          <Label htmlFor="reject-reason">{t("observability.reason")}</Label>
          <Input
            id="reject-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
      </Dialog>
    </section>
  );
}

function PendingRow({
  document,
  pending,
  onApprove,
  onReject,
}: {
  document: PendingDoc;
  pending: boolean;
  onApprove: (tags: string[]) => Promise<void>;
  onReject: () => void;
}) {
  const { t } = useI18n();
  const title = document.title ?? document.document_id;
  const [edited, setEdited] = useState(document.proposed_tags.join(", "));
  const tags = () =>
    edited
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
  return (
    <li className="grid gap-5 py-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold">{title}</h3>
          <Badge tone="warning">{t("observability.untrustedPreview")}</Badge>
        </div>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-text-secondary">
          {document.preview}
        </p>
        <p className="mt-2 font-mono text-xs text-text-tertiary">
          {document.source_id ?? document.document_id}
        </p>
      </div>
      <div className="space-y-3">
        <div className="grid gap-2">
          <Label htmlFor={`tags-${document.document_id}`}>
            {t("observability.proposedTags")}
          </Label>
          <Input
            id={`tags-${document.document_id}`}
            value={edited}
            onChange={(event) => setEdited(event.target.value)}
          />
        </div>
        <div className="flex gap-2">
          <Button
            disabled={pending || tags().length === 0}
            aria-label={t("observability.approveNamed", { title })}
            onClick={() => onApprove(tags())}
          >
            {t("observability.approve")}
          </Button>
          <Button
            variant="outline"
            disabled={pending}
            aria-label={t("observability.rejectNamed", { title })}
            onClick={onReject}
          >
            {t("observability.reject")}
          </Button>
        </div>
      </div>
    </li>
  );
}
