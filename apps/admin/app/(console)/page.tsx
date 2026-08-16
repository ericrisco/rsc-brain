"use client";

import { PageShell } from "@/components/page-shell";
import { Banner } from "@/components/ui/banner";
import { Link } from "@/components/ui/link";
import { Skeleton } from "@/components/ui/skeleton";
import { TrustRail, type TrustSegment } from "@/components/ui/trust-rail";
import { useHealth, usePats, useProductMetrics } from "@/lib/api/hooks";
import { useI18n } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";

export default function OverviewPage() {
  const { t } = useI18n();
  return (
    <PageShell title={t("overview.title")} subtitle={t("overview.subtitle")}>
      {(project) => <OverviewSurface project={project} />}
    </PageShell>
  );
}

function OverviewSurface({ project }: { project: string }) {
  const { t, locale } = useI18n();
  const metricsQuery = useProductMetrics(project, 30);
  const healthQuery = useHealth(project);
  const patsQuery = usePats();

  if (metricsQuery.isLoading || healthQuery.isLoading || patsQuery.isLoading) {
    return (
      <div role="status" aria-label={t("overview.loading")} className="space-y-6">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (metricsQuery.isError || healthQuery.isError || patsQuery.isError) {
    return (
      <Banner tone="danger" title={t("overview.loadError")}>
        {t("common.tryAgain")}
      </Banner>
    );
  }

  const metrics = metricsQuery.data;
  const health = healthQuery.data;
  if (!metrics || !health) return null;

  const activeConnections =
    patsQuery.data?.pats.filter((pat) => pat.project === project && !pat.revoked).length ?? 0;
  const tokens = Object.values(metrics.health.tokens_by_capability).reduce(
    (total, value) => total + value,
    0,
  );
  const openGaps = metrics.knowledge.open_gaps;
  const disputed = metrics.knowledge.disputed;
  const ingestErrors = health.ingest_errors;
  const pendingReview = health.pending_approval;
  const activeConnectionLabel = t(
    activeConnections === 1 ? "overview.activeConnection" : "overview.activeConnections",
    { n: formatNumber(activeConnections, locale) },
  );

  const segments: TrustSegment[] = [
    {
      id: "knowledge",
      label: t("overview.knowledge"),
      status: disputed + openGaps > 0 ? t("overview.needsAttention") : t("overview.clear"),
      detail: t("overview.disputedClaims", { n: formatNumber(disputed, locale) }),
      tone: disputed > 0 ? "warning" : "success",
      action: (
        <Link href="/knowledge?area=gaps">
          {t("overview.openGaps", { n: formatNumber(openGaps, locale) })}
        </Link>
      ),
    },
    {
      id: "operations",
      label: t("overview.operations"),
      status: ingestErrors > 0 ? t("overview.actionRequired") : t("overview.healthy"),
      detail: t("overview.databaseState", { state: health.database }),
      tone: ingestErrors > 0 ? "danger" : "success",
      action: (
        <Link href="/observability?tab=ingest">
          {t("overview.ingestFailures", { n: formatNumber(ingestErrors, locale) })}
        </Link>
      ),
    },
    {
      id: "access",
      label: t("overview.access"),
      status: t("overview.scoped"),
      detail: t("overview.projectScope", { project }),
      tone: "neutral",
      action: <Link href="/connections?status=active">{activeConnectionLabel}</Link>,
    },
    {
      id: "budget",
      label: t("overview.budget"),
      status: t("overview.measured"),
      detail: t("overview.window30"),
      tone: "neutral",
      action: (
        <Link href="/usage?window=30">
          {t("overview.tokens", { n: formatNumber(tokens, locale) })}
        </Link>
      ),
    },
  ];

  const attention = [
    ingestErrors > 0
      ? {
          id: "ingest",
          label: t("overview.ingestFailures", { n: formatNumber(ingestErrors, locale) }),
          description: t("overview.ingestFailuresHelp"),
          href: "/observability?tab=ingest",
          tone: "border-l-danger",
        }
      : null,
    disputed > 0
      ? {
          id: "disputed",
          label: t("overview.disputedClaims", { n: formatNumber(disputed, locale) }),
          description: t("overview.disputedClaimsHelp"),
          href: "/knowledge?area=disputed",
          tone: "border-l-warning",
        }
      : null,
    pendingReview > 0
      ? {
          id: "review",
          label: t("overview.awaitingReview", { n: formatNumber(pendingReview, locale) }),
          description: t("overview.awaitingReviewHelp"),
          href: "/review?status=pending",
          tone: "border-l-warning",
        }
      : null,
    openGaps > 0
      ? {
          id: "gaps",
          label: t("overview.openGaps", { n: formatNumber(openGaps, locale) }),
          description: t("overview.openGapsHelp"),
          href: "/knowledge?area=gaps",
          tone: "border-l-interactive",
        }
      : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null);

  return (
    <div className="space-y-8">
      <TrustRail segments={segments} label={t("overview.postureLabel")} />

      <section aria-labelledby="needs-attention-title" aria-label={t("overview.needsAttentionTitle")}>
        <div className="mb-3 flex items-end justify-between gap-4">
          <div>
            <p className="font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-interactive">
              {t("overview.priorityEyebrow")}
            </p>
            <h2 id="needs-attention-title" className="mt-1 text-xl font-semibold text-text-primary">
              {t("overview.needsAttentionTitle")}
            </h2>
          </div>
          <span className="font-mono text-xs text-text-secondary">
            {t("overview.signalCount", { n: attention.length })}
          </span>
        </div>

        {attention.length > 0 ? (
          <ul className="divide-y divide-border border-y border-border">
            {attention.map((item) => (
              <li key={item.id} className={`border-l-2 px-4 py-4 ${item.tone}`}>
                <Link href={item.href}>{item.label}</Link>
                <p className="mt-1 text-sm text-text-secondary">{item.description}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="border-y border-border py-6 text-sm text-text-secondary">
            {t("overview.noAttention")}
          </p>
        )}
      </section>
    </div>
  );
}
