"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { PageShell } from "@/components/page-shell";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useMe, useResolveChunk, useResolveMerge, useReviewQueue } from "@/lib/api/hooks";
import type { ReviewItem } from "@/lib/api/types";
import { useI18n } from "@/lib/i18n/context";

const SOURCES = [
  "all",
  "ambiguous_table",
  "guardrail",
  "agent_submission",
  "entity_merge",
  "agent_correction",
] as const;
type ReviewSource = (typeof SOURCES)[number];

export default function ReviewPage() {
  const { t } = useI18n();
  return (
    <PageShell title={t("review.title")} subtitle={t("review.subtitle")}>
      {(project) => <ReviewSurface project={project} />}
    </PageShell>
  );
}

function ReviewSurface({ project }: { project: string }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedSource = searchParams.get("source");
  const source: ReviewSource = SOURCES.includes(requestedSource as ReviewSource)
    ? (requestedSource as ReviewSource)
    : "all";
  const queue = useReviewQueue(project, source === "all" ? undefined : source);
  const session = useMe();
  const membership = session.data?.memberships.find((item) => item.project === project);
  const canDecide = Boolean(
    membership &&
      membership.role !== "viewer" &&
      (membership.can_curate || membership.role === "project-admin"),
  );
  const items = queue.data?.items ?? [];
  const requestedItem = searchParams.get("item");
  const selected = requestedItem
    ? items.find((item) => item.id === requestedItem) ?? null
    : items[0] ?? null;

  const replaceParams = (nextParams: URLSearchParams) => {
    router.replace(`${pathname}?${nextParams.toString()}`, { scroll: false });
  };
  const changeSource = (nextSource: string) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("source", nextSource);
    next.delete("item");
    replaceParams(next);
  };
  const selectItem = (item: ReviewItem) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("source", source);
    next.set("item", item.id);
    replaceParams(next);
  };

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-interactive">
              {t("review.workQueue")}
            </p>
            <h2 className="mt-1 text-xl font-semibold">{t("review.pending")}</h2>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="review-source">{t("review.source")}</Label>
            <Select
              id="review-source"
              value={source}
              onChange={(event) => changeSource(event.target.value)}
            >
              <option value="all">{t("review.allSources")}</option>
              <option value="ambiguous_table">{t("review.ambiguousTable")}</option>
              <option value="guardrail">{t("review.guardrail")}</option>
              <option value="agent_submission">{t("review.agentSubmission")}</option>
              <option value="entity_merge">{t("review.entityMerge")}</option>
              <option value="agent_correction">{t("review.agentCorrection")}</option>
            </Select>
          </div>
        </div>

        <ul className="flex flex-wrap gap-2" aria-label={t("review.sourceCounts")}>
          {Object.entries(queue.data?.counts ?? {}).map(([itemSource, count]) => (
            <li key={itemSource}>
              <Badge tone={itemSource === source ? "info" : "neutral"}>
                {sourceLabel(itemSource, t)} {count}
              </Badge>
            </li>
          ))}
        </ul>
      </div>

      {queue.isLoading ? <Skeleton className="h-[28rem] w-full" /> : null}
      {queue.isError ? (
        <Banner tone="danger" title={t("review.loadError")}>
          {t("common.tryAgain")}
        </Banner>
      ) : null}
      {!queue.isLoading && !queue.isError && items.length === 0 ? (
        <p className="border-y border-border py-10 text-sm text-text-secondary">
          {t("review.nothingToReview")}
        </p>
      ) : null}
      {!queue.isLoading && !queue.isError && items.length > 0 && !selected ? (
        <Banner tone="warning" title={t("review.itemUnavailable")}>
          {t("review.itemUnavailableHelp")}
        </Banner>
      ) : null}
      {!queue.isLoading && !queue.isError && selected ? (
        <div className="grid min-h-[28rem] border-y border-border lg:grid-cols-[20rem_minmax(0,1fr)]">
          <section
            role="region"
            aria-label={t("review.queueRegion")}
            className="border-b border-border lg:border-b-0 lg:border-r"
          >
            <ol className="divide-y divide-border">
              {items.map((item) => {
                const active = item.id === selected.id;
                return (
                  <li key={`${item.source}:${item.id}`}>
                    <button
                      type="button"
                      aria-current={active ? "true" : undefined}
                      onClick={() => selectItem(item)}
                      className={`w-full border-l-2 px-4 py-4 text-left transition-colors ${
                        active
                          ? "border-l-interactive bg-selected"
                          : "border-l-transparent hover:bg-surface-subtle"
                      }`}
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="text-xs font-medium text-text-secondary">
                          {sourceLabel(item.source, t)}
                        </span>
                        <span className="font-mono text-[0.625rem] text-text-tertiary">
                          {item.id}
                        </span>
                      </span>
                      <span className="mt-2 block text-sm leading-5 text-text-primary">
                        {item.preview}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
          <ReviewEvidence
            key={`${selected.source}:${selected.id}`}
            item={selected}
            project={project}
            canDecide={canDecide}
          />
        </div>
      ) : null}
    </div>
  );
}

function ReviewEvidence({
  item,
  project,
  canDecide,
}: {
  item: ReviewItem;
  project: string;
  canDecide: boolean;
}) {
  const { t } = useI18n();
  const resolveChunk = useResolveChunk(project);
  const resolveMerge = useResolveMerge(project);
  const initialTags = stringList(item.detail.tags).join(", ");
  const [topics, setTopics] = useState(initialTags);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState(false);
  const isChunk = ["ambiguous_table", "guardrail", "agent_submission"].includes(item.source);
  const isMerge = item.source === "entity_merge";
  const canResolve = canDecide && (isChunk || isMerge);

  async function decide(approve: boolean) {
    setMutationError(false);
    setFeedback(null);
    try {
      const outcome = isChunk
        ? await resolveChunk.mutateAsync({
            chunkId: item.id,
            approve,
            tags: topics
              .split(",")
              .map((topic) => topic.trim())
              .filter(Boolean),
          })
        : await resolveMerge.mutateAsync({ proposalId: item.id, approve });
      const resolved = outcome.outcome === "already_resolved";
      setFeedback(
        resolved
          ? t("review.alreadyResolved")
          : approve
            ? t("review.itemApproved")
            : t("review.itemRejected"),
      );
    } catch {
      setMutationError(true);
    }
  }

  return (
    <section
      role="region"
      aria-label={t("review.evidenceRegion")}
      className="min-w-0 px-5 py-5 lg:px-7"
    >
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.08em] text-text-secondary">
            {sourceLabel(item.source, t)}
          </p>
          <h2 className="mt-1 text-lg font-semibold">{t("review.evidenceTitle")}</h2>
        </div>
        <Badge tone="warning">{t("review.untrustedPreview")}</Badge>
      </div>

      <p className="my-5 whitespace-pre-wrap text-sm leading-6 text-text-primary">{item.preview}</p>
      <EvidenceDetails item={item} />

      {isChunk ? (
        <div className="mt-5 grid gap-2 border-t border-border pt-5">
          <Label htmlFor={`review-topics-${item.id}`}>{t("review.topics")}</Label>
          <Input
            id={`review-topics-${item.id}`}
            value={topics}
            disabled={!canDecide}
            onChange={(event) => setTopics(event.target.value)}
          />
          <p className="text-xs text-text-secondary">{t("review.topicsHelp")}</p>
        </div>
      ) : null}

      {mutationError ? (
        <Banner className="mt-5" tone="danger" title={t("review.decisionError")}>
          {t("common.tryAgain")}
        </Banner>
      ) : null}
      {feedback ? (
        <p role="status" className="mt-5 border-l-2 border-l-success bg-success-muted px-3 py-3 text-sm">
          {feedback}
        </p>
      ) : null}

      {canResolve ? (
        <div className="mt-6 flex flex-wrap gap-2 border-t border-border pt-5">
          <Button
            disabled={resolveChunk.isPending || resolveMerge.isPending}
            onClick={() => decide(true)}
          >
            {t("review.approveItem")}
          </Button>
          <Button
            variant="outline"
            disabled={resolveChunk.isPending || resolveMerge.isPending}
            onClick={() => decide(false)}
          >
            {t("review.rejectItem")}
          </Button>
        </div>
      ) : !canDecide ? (
        <p className="mt-6 border-t border-border pt-5 text-sm text-text-secondary">
          {t("review.readOnly")}
        </p>
      ) : (
        <p className="mt-6 border-t border-border pt-5 text-sm text-text-secondary">
          {t("review.resolveInKnowledge")}
        </p>
      )}
    </section>
  );
}

function EvidenceDetails({ item }: { item: ReviewItem }) {
  const { t } = useI18n();
  const rows =
    item.source === "entity_merge"
      ? [
          [t("review.canonicalEntity"), stringValue(item.detail.canonical_entity_id)],
          [t("review.duplicateEntity"), stringValue(item.detail.duplicate_entity_id)],
          [
            t("review.confidence"),
            typeof item.detail.confidence === "number"
              ? `${Math.round(item.detail.confidence * 100)}%`
              : "—",
          ],
        ]
      : item.source === "agent_correction"
        ? [[t("review.targetClaim"), stringValue(item.detail.target_claim)]]
        : [
            [t("review.document"), stringValue(item.detail.document_id)],
            [t("review.kind"), stringValue(item.detail.kind)],
            [t("review.currentTopics"), stringList(item.detail.tags).join(", ") || "—"],
          ];
  return (
    <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-4 gap-y-2 border-y border-border py-4 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-text-secondary">{label}</dt>
          <dd className="min-w-0 break-words font-mono text-xs text-text-primary">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "—";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function sourceLabel(
  source: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const labels: Record<string, string> = {
    ambiguous_table: t("review.ambiguousTable"),
    guardrail: t("review.guardrail"),
    agent_submission: t("review.agentSubmission"),
    entity_merge: t("review.entityMerge"),
    agent_correction: t("review.agentCorrection"),
  };
  return labels[source] ?? source;
}
