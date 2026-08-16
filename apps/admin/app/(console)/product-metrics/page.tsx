"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { PageShell } from "@/components/page-shell";
import { Banner } from "@/components/ui/banner";
import { Label } from "@/components/ui/label";
import { Link } from "@/components/ui/link";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useProductMetrics } from "@/lib/api/hooks";
import type { ProductMetrics } from "@/lib/api/types";
import { useI18n } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";

const WINDOWS = [7, 30, 90] as const;

export default function ProductMetricsPage() {
  const { t } = useI18n();
  return (
    <PageShell title={t("metrics.title")} subtitle={t("metrics.subtitle")}>
      {(project) => <ProductMetricsSurface project={project} />}
    </PageShell>
  );
}

function ProductMetricsSurface({ project }: { project: string }) {
  const { t, locale } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedWindow = Number(searchParams.get("window"));
  const [windowDays, setWindowDays] = useState<(typeof WINDOWS)[number]>(() =>
    WINDOWS.includes(requestedWindow as (typeof WINDOWS)[number])
      ? (requestedWindow as (typeof WINDOWS)[number])
      : 30,
  );
  useEffect(() => {
    if (WINDOWS.includes(requestedWindow as (typeof WINDOWS)[number])) {
      setWindowDays(requestedWindow as (typeof WINDOWS)[number]);
    }
  }, [requestedWindow]);
  const { data, isLoading, isError } = useProductMetrics(project, windowDays);
  const num = (value: number | null | undefined) =>
    value === null || value === undefined ? "—" : formatNumber(value, locale);
  const pct = (value: number | null | undefined) =>
    value === null || value === undefined
      ? "—"
      : new Intl.NumberFormat(locale === "es" ? "es-ES" : "en-US", {
          style: "percent",
          maximumFractionDigits: 1,
        }).format(value);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
        <div>
          <p className="font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-text-secondary">
            {t("metrics.scope")}
          </p>
          <p className="mt-1 text-sm font-medium text-text-primary">{project}</p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="metrics-window">{t("metrics.window")}</Label>
          <Select
            id="metrics-window"
            className="min-w-40"
            value={windowDays}
            onChange={(event) => {
              const nextWindow = Number(event.target.value) as (typeof WINDOWS)[number];
              setWindowDays(nextWindow);
              const nextParams = new URLSearchParams(searchParams.toString());
              nextParams.set("window", String(nextWindow));
              router.replace(`${pathname}?${nextParams.toString()}`, { scroll: false });
            }}
          >
            {WINDOWS.map((days) => (
              <option key={days} value={days}>
                {t("metrics.days", { n: days })}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {isLoading ? <MetricsLoading label={t("metrics.loading")} /> : null}
      {isError ? (
        <Banner tone="danger" title={t("metrics.loadError")}>
          {t("common.tryAgain")}
        </Banner>
      ) : null}
      {data ? (
        <div className="divide-y divide-border border-y border-border">
          <MetricFamily
            id="adoption"
            title={t("metrics.adoption")}
            interpretation={adoptionInterpretation(data, t)}
            definition={t("metrics.adoptionDefinition")}
            action={{ href: "/observability?tab=recalls", label: t("metrics.exploreRecalls") }}
          >
            <MetricValue
              testId="metric-recalls"
              label={t("metrics.recalls")}
              value={num(data.adoption.recalls)}
              unit={t("metrics.events")}
              primary
            />
            <MetricValue
              label={t("metrics.activePrincipals")}
              value={num(data.adoption.active_principals)}
              unit={t("metrics.principals")}
            />
            <RecallTrend data={data.adoption.recalls_per_day} />
          </MetricFamily>

          <MetricFamily
            id="quality"
            title={t("metrics.quality")}
            interpretation={t("metrics.qualityInterpretation")}
            definition={t("metrics.qualityDefinition")}
            action={{ href: "/review", label: t("metrics.openReview") }}
          >
            <MetricValue label={t("metrics.abstentionRate")} value={pct(data.quality.abstention_rate)} />
            <MetricValue label={t("metrics.huntsAnswered")} value={pct(data.quality.hunts_answered_pct)} />
          </MetricFamily>

          <MetricFamily
            id="knowledge"
            title={t("metrics.knowledge")}
            interpretation={t("metrics.knowledgeInterpretation")}
            definition={t("metrics.knowledgeDefinition")}
            action={{ href: "/knowledge", label: t("metrics.inspectKnowledge") }}
          >
            <MetricValue label={t("metrics.claims")} value={num(data.knowledge.claims)} />
            <MetricValue label={t("metrics.disputed")} value={num(data.knowledge.disputed)} />
            <MetricValue label={t("metrics.openGaps")} value={num(data.knowledge.open_gaps)} />
          </MetricFamily>

          <MetricFamily
            id="health"
            title={t("metrics.health")}
            interpretation={t("metrics.healthInterpretation")}
            definition={t("metrics.healthDefinition")}
            action={{ href: "/observability", label: t("metrics.openObservability") }}
          >
            <MetricValue
              label={t("metrics.extractionErrors")}
              value={num(data.health.extraction_errors)}
            />
            <MetricValue
              testId="metric-p95"
              label={t("metrics.p95")}
              value={num(data.health.recall_p95_ms)}
              unit={data.health.recall_p95_ms === null ? undefined : "ms"}
            />
            <TokenBreakdown tokens={data.health.tokens_by_capability} />
          </MetricFamily>
        </div>
      ) : null}
    </div>
  );
}

function MetricFamily({
  id,
  title,
  interpretation,
  definition,
  action,
  children,
}: {
  id: string;
  title: string;
  interpretation: string;
  definition: string;
  action: { href: string; label: string };
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <section
      aria-labelledby={`metric-family-${id}`}
      aria-label={title}
      className="grid gap-6 py-7 lg:grid-cols-[15rem_minmax(0,1fr)]"
    >
      <div>
        <h2 id={`metric-family-${id}`} className="text-xl font-semibold text-text-primary">
          {title}
        </h2>
        <p className="mt-2 text-sm leading-6 text-text-secondary">{interpretation}</p>
        <Link
          href={action.href}
          className="mt-4 inline-flex rounded-[2px] text-sm font-medium text-interactive underline decoration-interactive/35 underline-offset-4"
        >
          {action.label}
        </Link>
      </div>
      <div>
        <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
        <details className="mt-5 border-t border-border pt-3 text-sm text-text-secondary">
          <summary className="cursor-pointer font-medium text-text-primary">
            {t("metrics.howMeasured")}
          </summary>
          <p className="mt-2 max-w-3xl leading-6">{definition}</p>
        </details>
      </div>
    </section>
  );
}

function MetricValue({
  label,
  value,
  unit,
  primary = false,
  testId,
}: {
  label: string;
  value: string;
  unit?: string;
  primary?: boolean;
  testId?: string;
}) {
  return (
    <div data-testid={testId}>
      <p className="text-xs text-text-secondary">{label}</p>
      <p
        className={`mt-1 font-mono font-medium tabular-nums text-text-primary ${
          primary ? "text-3xl" : "text-2xl"
        }`}
      >
        {value}
        {unit ? <span className="ml-2 text-xs font-normal text-text-secondary">{unit}</span> : null}
      </p>
    </div>
  );
}

function RecallTrend({ data }: { data: ProductMetrics["adoption"]["recalls_per_day"] }) {
  const { t, locale } = useI18n();
  const max = Math.max(1, ...data.map((row) => row.recalls));
  return (
    <div className="sm:col-span-2 xl:col-span-1">
      <p className="text-xs text-text-secondary">{t("metrics.recentTrend")}</p>
      {data.length === 0 ? (
        <p className="mt-1 font-mono text-2xl text-text-primary">—</p>
      ) : (
        <ul className="mt-2 space-y-2" aria-label={t("metrics.recentTrend")}>
          {data.slice(-5).map((row) => (
            <li key={row.day} className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-2 text-xs">
              <span className="font-mono text-text-secondary">{row.day.slice(5)}</span>
              <span className="h-1.5 bg-surface-subtle" aria-hidden="true">
                <span
                  className="block h-full bg-interactive"
                  style={{
                    width: `${row.recalls === 0 ? 0 : Math.max(2, (row.recalls / max) * 100)}%`,
                  }}
                />
              </span>
              <span className="font-mono tabular-nums text-text-primary">
                {formatNumber(row.recalls, locale)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TokenBreakdown({ tokens }: { tokens: Record<string, number> }) {
  const { t, locale } = useI18n();
  const entries = Object.entries(tokens).sort(([left], [right]) => left.localeCompare(right));
  return (
    <div className="sm:col-span-2 xl:col-span-1">
      <p className="text-xs text-text-secondary">{t("metrics.tokensByCapability")}</p>
      {entries.length === 0 ? (
        <p className="mt-1 font-mono text-2xl text-text-primary">—</p>
      ) : (
        <dl className="mt-2 space-y-2">
          {entries.map(([capability, value]) => (
            <div key={capability} className="flex items-center justify-between gap-4 text-xs">
              <dt className="truncate text-text-secondary">{capability}</dt>
              <dd className="font-mono tabular-nums text-text-primary">
                {formatNumber(value, locale)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function MetricsLoading({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-4">
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

function adoptionInterpretation(
  data: ProductMetrics,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const days = data.adoption.recalls_per_day;
  if (days.length < 2) return t("metrics.adoptionNoComparison");
  const previous = days.at(-2)?.recalls ?? 0;
  const current = days.at(-1)?.recalls ?? 0;
  if (current === previous) return t("metrics.adoptionFlat");
  return current > previous ? t("metrics.adoptionUp") : t("metrics.adoptionDown");
}
