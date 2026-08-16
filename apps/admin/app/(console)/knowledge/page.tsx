"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { PageShell } from "@/components/page-shell";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { DataTable, type DataColumn } from "@/components/ui/data-table";
import { Dialog } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs } from "@/components/ui/tabs";
import { TrustRail, type TrustSegment } from "@/components/ui/trust-rail";
import {
  useCorrectionMetrics,
  useCorrections,
  useDisputed,
  useGaps,
  useHunts,
  useMe,
  usePromoteGap,
  useResolutions,
  useRevertCorrection,
} from "@/lib/api/hooks";
import type { Correction, DisputedClaim, Gap, Hunt, Resolution } from "@/lib/api/types";
import { useI18n } from "@/lib/i18n/context";
import { formatDateTime, formatNumber } from "@/lib/i18n/format";

const AREAS = ["gaps", "hunts", "disputed", "resolutions", "corrections"] as const;
type KnowledgeArea = (typeof AREAS)[number];

export default function KnowledgePage() {
  const { t } = useI18n();
  return (
    <PageShell title={t("knowledge.title")} subtitle={t("knowledge.subtitle")}>
      {(project) => <KnowledgeSurface project={project} />}
    </PageShell>
  );
}

function KnowledgeSurface({ project }: { project: string }) {
  const { t, locale } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requested = searchParams.get("area");
  const area: KnowledgeArea = AREAS.includes(requested as KnowledgeArea)
    ? (requested as KnowledgeArea)
    : "gaps";
  const audience = searchParams.get("audience") === "agent" ? "agent" : "human";
  const session = useMe();
  const membership = session.data?.memberships.find((item) => item.project === project);
  const canPromote = membership?.role === "project-admin";
  const humanGaps = useGaps(project, false);
  const hunts = useHunts(project);
  const disputed = useDisputed(project);
  const metrics = useCorrectionMetrics(project);

  const changeArea = (nextArea: string) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("area", nextArea);
    if (!next.has("audience")) next.set("audience", audience);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  const openGapCount = humanGaps.data?.gaps.filter((gap) => gap.status === "open").length ?? 0;
  const activeHuntCount = hunts.data?.hunts.filter(
    (hunt) => !["resolved", "expired", "closed"].includes(hunt.state),
  ).length ?? 0;
  const disputedCount = disputed.data?.claims.length ?? 0;
  const pendingCorrectionCount = metrics.data?.by_status.pending_confirmation ?? 0;
  const posture: TrustSegment[] = [
    {
      id: "gaps",
      label: t("knowledge.gapsTitle"),
      status: formatNumber(openGapCount, locale),
      detail: t("knowledge.openHumanGaps"),
      tone: openGapCount > 0 ? "warning" : "success",
    },
    {
      id: "hunts",
      label: t("knowledge.huntsTitle"),
      status: formatNumber(activeHuntCount, locale),
      detail: t("knowledge.activeHunts"),
      tone: activeHuntCount > 0 ? "neutral" : "success",
    },
    {
      id: "disputed",
      label: t("knowledge.disputedTitle"),
      status: formatNumber(disputedCount, locale),
      detail: t("knowledge.disputedHelp"),
      tone: disputedCount > 0 ? "warning" : "success",
    },
    {
      id: "corrections",
      label: t("knowledge.correctionsTitle"),
      status: formatNumber(pendingCorrectionCount, locale),
      detail: t("knowledge.pendingConfirmation"),
      tone: pendingCorrectionCount > 0 ? "warning" : "success",
    },
  ];
  const tabs = [
    { value: "gaps", label: t("knowledge.gapsTitle") },
    { value: "hunts", label: t("knowledge.huntsTitle") },
    { value: "disputed", label: t("knowledge.disputedTab") },
    { value: "resolutions", label: t("knowledge.resolutionsTab") },
    { value: "corrections", label: t("knowledge.correctionsTitle") },
  ];

  return (
    <div className="space-y-7">
      <TrustRail segments={posture} label={t("knowledge.postureLabel")} />
      <Tabs items={tabs} value={area} onValueChange={changeArea} label={t("knowledge.areasLabel")}>
        {area === "gaps" ? (
          <GapsWorkspace
            project={project}
            audience={audience}
            canPromote={canPromote}
            searchParams={searchParams}
          />
        ) : null}
        {area === "hunts" ? <HuntsWorkspace query={hunts} /> : null}
        {area === "disputed" ? <DisputedWorkspace query={disputed} /> : null}
        {area === "resolutions" ? <ResolutionsWorkspace project={project} /> : null}
        {area === "corrections" ? (
          <CorrectionsWorkspace
            project={project}
            canRevert={Boolean(membership && membership.role !== "viewer")}
          />
        ) : null}
      </Tabs>
    </div>
  );
}

type QueryResult<Data> = { data?: Data; isLoading: boolean; isError: boolean };

function GapsWorkspace({
  project,
  audience,
  canPromote,
  searchParams,
}: {
  project: string;
  audience: "human" | "agent";
  canPromote: boolean;
  searchParams: URLSearchParams;
}) {
  const { t, locale } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const query = useGaps(project, audience === "agent");
  const promote = usePromoteGap(project);
  const [target, setTarget] = useState<Gap | null>(null);
  const [mutationError, setMutationError] = useState(false);
  const columns: DataColumn<Gap>[] = [
    {
      key: "question",
      label: t("knowledge.question"),
      render: (gap) => gap.query_text ?? t("knowledge.queryTextHiddenByPolicy"),
    },
    {
      key: "frequency",
      label: t("knowledge.frequency"),
      align: "right",
      render: (gap) => formatNumber(gap.count, locale),
    },
    {
      key: "topics",
      label: t("knowledge.topics"),
      render: (gap) => gap.topics.join(", ") || "—",
    },
    {
      key: "last_seen",
      label: t("knowledge.lastSeen"),
      render: (gap) => formatDateTime(gap.last_seen_at, locale),
    },
    {
      key: "status",
      label: t("connections.status"),
      render: (gap) => <Badge tone={gap.status === "open" ? "warning" : "neutral"}>{gap.status}</Badge>,
    },
    ...(audience === "agent" && canPromote
      ? [
          {
            key: "action",
            label: t("connections.actions"),
            align: "right" as const,
            render: (gap: Gap) => (
              <Button
                variant="outline"
                size="sm"
                aria-label={t("knowledge.promoteGapToHunt")}
                onClick={() => setTarget(gap)}
              >
                {t("knowledge.promoteToHunt")}
              </Button>
            ),
          },
        ]
      : []),
  ];

  const changeAudience = (nextAudience: string) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("area", "gaps");
    next.set("audience", nextAudience);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  async function onPromote() {
    if (!target) return;
    setMutationError(false);
    try {
      await promote.mutateAsync(target.id);
      setTarget(null);
    } catch {
      setMutationError(true);
    }
  }

  return (
    <section aria-labelledby="knowledge-gaps-title" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 id="knowledge-gaps-title" className="text-xl font-semibold">
            {t("knowledge.gapsTitle")}
          </h2>
          <p className="mt-1 text-sm text-text-secondary">
            {audience === "agent" ? t("knowledge.gapsAgentDesc") : t("knowledge.gapsHumanDesc")}
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="gap-audience">{t("knowledge.audience")}</Label>
          <Select id="gap-audience" value={audience} onChange={(event) => changeAudience(event.target.value)}>
            <option value="human">{t("knowledge.humanCreated")}</option>
            <option value="agent">{t("knowledge.agentCreated")}</option>
          </Select>
        </div>
      </div>
      {mutationError ? <Banner tone="danger" title={t("knowledge.promoteError")}>{t("common.tryAgain")}</Banner> : null}
      {query.isLoading ? <Skeleton className="h-56 w-full" /> : null}
      {query.isError ? <Banner tone="danger" title={t("knowledge.loadError")}>{t("common.tryAgain")}</Banner> : null}
      {!query.isLoading && !query.isError ? (
        <DataTable caption={t("knowledge.gapTableLabel")} columns={columns} rows={query.data?.gaps ?? []} rowKey={(gap) => gap.id} emptyTitle={t("knowledge.noGaps")} />
      ) : null}
      <Dialog
        open={target !== null}
        onClose={() => setTarget(null)}
        title={t("knowledge.promoteDialogTitle")}
        description={t("knowledge.promoteDialogDescription")}
        cancelLabel={t("common.cancel")}
        actions={<Button disabled={promote.isPending} onClick={onPromote}>{t("knowledge.promoteNow")}</Button>}
      >
        {target ? (
          <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-text-secondary">{t("knowledge.question")}</dt>
            <dd>{target.query_text ?? t("knowledge.queryTextHiddenByPolicy")}</dd>
            <dt className="text-text-secondary">{t("knowledge.topics")}</dt>
            <dd>{target.topics.join(", ") || "—"}</dd>
          </dl>
        ) : null}
      </Dialog>
    </section>
  );
}

function HuntsWorkspace({ query }: { query: QueryResult<{ hunts: Hunt[] }> }) {
  const { t, locale } = useI18n();
  const columns: DataColumn<Hunt>[] = [
    { key: "state", label: t("knowledge.state"), render: (hunt) => <Badge tone={hunt.state === "asked" ? "info" : "neutral"}>{hunt.state}</Badge> },
    { key: "question", label: t("knowledge.question"), render: (hunt) => hunt.question ?? "—" },
    { key: "topics", label: t("knowledge.topics"), render: (hunt) => hunt.topics.join(", ") || "—" },
    { key: "owner", label: t("knowledge.owner"), render: (hunt) => hunt.person_id ?? "—" },
    { key: "channel", label: t("knowledge.channel"), render: (hunt) => hunt.channel ?? "—" },
    { key: "deadline", label: t("knowledge.deadline"), render: (hunt) => formatDateTime(hunt.expires_at, locale) },
    { key: "retries", label: t("knowledge.retriesLabel"), align: "right", render: (hunt) => hunt.retries },
  ];
  return <KnowledgeTableState title={t("knowledge.huntsTitle")} caption={t("knowledge.huntsTableLabel")} query={query} rows={query.data?.hunts ?? []} columns={columns} rowKey={(hunt) => hunt.id} empty={t("knowledge.noHunts")} />;
}

function DisputedWorkspace({ query }: { query: QueryResult<{ claims: DisputedClaim[] }> }) {
  const { t, locale } = useI18n();
  const columns: DataColumn<DisputedClaim>[] = [
    { key: "claim", label: t("knowledge.claim"), render: (claim) => <div><p>{claim.text}</p><p className="mt-1 font-mono text-xs text-text-tertiary">{claim.id}</p></div> },
    { key: "credibility", label: t("knowledge.credibility"), align: "right", render: (claim) => `${Math.round(claim.credibility * 100)}%` },
    { key: "validity", label: t("knowledge.validity"), render: (claim) => claim.valid_to ? formatDateTime(claim.valid_to, locale) : t("knowledge.noExpiry") },
    { key: "topics", label: t("knowledge.topics"), render: (claim) => claim.tags.join(", ") || "—" },
  ];
  return <KnowledgeTableState title={t("knowledge.disputedTitle")} caption={t("knowledge.disputedTableLabel")} query={query} rows={query.data?.claims ?? []} columns={columns} rowKey={(claim) => claim.id} empty={t("knowledge.nothingDisputed")} />;
}

function ResolutionsWorkspace({ project }: { project: string }) {
  const { t } = useI18n();
  const query = useResolutions(project);
  if (query.isLoading) return <Skeleton className="h-56 w-full" />;
  if (query.isError) return <Banner tone="danger" title={t("knowledge.loadError")}>{t("common.tryAgain")}</Banner>;
  return (
    <section role="region" aria-label={t("knowledge.resolutionsTitle")} className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">{t("knowledge.resolutionsTitle")}</h2>
        <p className="mt-1 text-sm text-text-secondary">{t("knowledge.resolutionsDesc")}</p>
      </div>
      {(query.data?.resolutions ?? []).length === 0 ? <p className="border-y border-border py-8 text-sm text-text-secondary">{t("knowledge.noResolutions")}</p> : (
        <ol className="divide-y divide-border border-y border-border">
          {(query.data?.resolutions ?? []).map((resolution) => <ResolutionRow key={`${resolution.winner.claim_id}:${resolution.loser.claim_id}`} resolution={resolution} />)}
        </ol>
      )}
    </section>
  );
}

function ResolutionRow({ resolution }: { resolution: Resolution }) {
  const { t } = useI18n();
  return (
    <li className="grid gap-5 py-5 lg:grid-cols-2">
      <div className="border-l-2 border-l-success pl-4">
        <p className="text-xs font-medium uppercase tracking-[0.08em] text-text-secondary">{t("knowledge.winner")}</p>
        <p className="mt-2">{resolution.winner.text}</p>
        <p className="mt-1 font-mono text-xs text-text-tertiary">{resolution.winner.claim_id} · {Math.round(resolution.winner.credibility * 100)}%</p>
      </div>
      <div className="border-l-2 border-l-border-strong pl-4">
        <p className="text-xs font-medium uppercase tracking-[0.08em] text-text-secondary">{t("knowledge.superseded")}</p>
        <p className="mt-2">{resolution.loser.text}</p>
        <p className="mt-1 font-mono text-xs text-text-tertiary">{resolution.loser.claim_id} · {Math.round(resolution.loser.credibility * 100)}%</p>
      </div>
      <p className="text-xs text-text-secondary lg:col-span-2">{t("knowledge.judgeSummary", { version: resolution.judge_version, confidence: Math.round(resolution.confidence * 100) })}</p>
    </li>
  );
}

function CorrectionsWorkspace({ project, canRevert }: { project: string; canRevert: boolean }) {
  const { t, locale } = useI18n();
  const query = useCorrections(project);
  const revert = useRevertCorrection(project);
  const [target, setTarget] = useState<Correction | null>(null);
  const [mutationError, setMutationError] = useState(false);
  const columns: DataColumn<Correction>[] = [
    { key: "change", label: t("knowledge.change"), render: (correction) => <div className="space-y-1"><p><span className="text-text-secondary">{t("knowledge.before")}: </span>{correction.before_text ?? "—"}</p><p><span className="text-text-secondary">{t("knowledge.after")}: </span>{correction.after_text ?? "—"}</p></div> },
    { key: "actor", label: t("knowledge.actor"), render: (correction) => correction.author_id ?? correction.on_behalf_of ?? "—" },
    { key: "role", label: t("knowledge.role"), render: (correction) => correction.role_applied ?? "—" },
    { key: "status", label: t("connections.status"), render: (correction) => <Badge tone={correction.status === "applied" ? "success" : "neutral"}>{correction.status}</Badge> },
    { key: "time", label: t("knowledge.created"), render: (correction) => formatDateTime(correction.created_at, locale) },
    { key: "action", label: t("connections.actions"), align: "right", render: (correction) => correction.status === "applied" && canRevert ? <Button variant="outline" size="sm" aria-label={t("knowledge.revertCorrection")} onClick={() => setTarget(correction)}>{t("knowledge.revert")}</Button> : "—" },
  ];
  async function onRevert() {
    if (!target) return;
    setMutationError(false);
    try {
      await revert.mutateAsync(target.id);
      setTarget(null);
    } catch {
      setMutationError(true);
    }
  }
  return (
    <section className="space-y-4" aria-labelledby="corrections-title">
      <h2 id="corrections-title" className="text-xl font-semibold">{t("knowledge.correctionsTitle")}</h2>
      {mutationError ? <Banner tone="danger" title={t("knowledge.revertError")}>{t("common.tryAgain")}</Banner> : null}
      {query.isLoading ? <Skeleton className="h-56 w-full" /> : null}
      {query.isError ? <Banner tone="danger" title={t("knowledge.loadError")}>{t("common.tryAgain")}</Banner> : null}
      {!query.isLoading && !query.isError ? <DataTable caption={t("knowledge.correctionsTableLabel")} columns={columns} rows={query.data?.corrections ?? []} rowKey={(correction) => correction.id} emptyTitle={t("knowledge.noCorrections")} /> : null}
      <Dialog open={target !== null} onClose={() => setTarget(null)} title={t("knowledge.revertDialogTitle")} description={t("knowledge.revertDialogDescription")} cancelLabel={t("common.cancel")} destructive actions={<Button variant="destructive" disabled={revert.isPending} onClick={onRevert}>{t("knowledge.revertNow")}</Button>}>
        {target ? <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm"><dt className="text-text-secondary">{t("knowledge.affectedClaim")}</dt><dd className="font-mono text-xs">{target.target_claim}</dd><dt className="text-text-secondary">{t("knowledge.change")}</dt><dd>{target.after_text ?? "—"}</dd></dl> : null}
      </Dialog>
    </section>
  );
}

function KnowledgeTableState<Row>({ title, caption, query, rows, columns, rowKey, empty }: { title: string; caption: string; query: QueryResult<unknown>; rows: Row[]; columns: DataColumn<Row>[]; rowKey: (row: Row) => string; empty: string }) {
  const { t } = useI18n();
  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold">{title}</h2>
      {query.isLoading ? <Skeleton className="h-56 w-full" /> : null}
      {query.isError ? <Banner tone="danger" title={t("knowledge.loadError")}>{t("common.tryAgain")}</Banner> : null}
      {!query.isLoading && !query.isError ? <DataTable caption={caption} columns={columns} rows={rows} rowKey={rowKey} emptyTitle={empty} /> : null}
    </section>
  );
}
