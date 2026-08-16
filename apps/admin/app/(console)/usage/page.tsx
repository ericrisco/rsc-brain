"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { PageShell } from "@/components/page-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type DataColumn } from "@/components/ui/data-table";
import { Select } from "@/components/ui/select";
import { useUsage } from "@/lib/api/hooks";
import type { UsageRow } from "@/lib/api/types";
import { useI18n } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";

const WINDOWS = new Set([7, 14, 30, 90]);

export default function UsagePage() {
  const { t } = useI18n();
  return (
    <PageShell title={t("usage.title")} subtitle={t("usage.subtitle")}>
      {(project) => <UsageWorkspace project={project} />}
    </PageShell>
  );
}

function UsageWorkspace({ project }: { project: string }) {
  const { t, locale } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedWindow = Number(searchParams.get("window"));
  const days = WINDOWS.has(requestedWindow) ? requestedWindow : 30;
  const selectedCapability = searchParams.get("capability") || "all";
  const capability = selectedCapability === "all" ? undefined : selectedCapability;
  const query = useUsage(project, days, capability);
  const rows = query.data?.usage ?? [];
  const capabilities = query.data?.capabilities ?? Array.from(new Set(rows.map((row) => row.capability))).sort();
  if (capability && !capabilities.includes(capability)) capabilities.unshift(capability);

  function update(key: "window" | "capability", value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  const columns: DataColumn<UsageRow>[] = [
    {
      key: "day",
      label: t("usage.day"),
      render: (row) => <span className="font-mono text-xs">{row.day}</span>,
    },
    { key: "capability", label: t("usage.capability"), render: (row) => row.capability },
    {
      key: "tokens",
      label: t("usage.tokens"),
      align: "right",
      render: (row) => formatNumber(row.tokens, locale),
    },
    {
      key: "calls",
      label: t("usage.calls"),
      align: "right",
      render: (row) => formatNumber(row.calls, locale),
    },
  ];

  return (
    <div className="space-y-5">
      <section aria-label={t("usage.summary")} className="grid gap-3 sm:grid-cols-3">
        <SummaryMetric
          label={t("usage.tokenTotal")}
          value={query.data ? formatNumber(query.data.total_tokens, locale) : "—"}
        />
        <SummaryMetric
          label={t("usage.callTotal")}
          value={query.data ? formatNumber(query.data.total_calls, locale) : "—"}
        />
        <SummaryMetric label={t("usage.budget")} value={t("usage.budgetUnavailable")} compact />
      </section>

      <Card>
        <CardHeader className="gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <CardTitle>{t("usage.title")}</CardTitle>
            <CardDescription>{t("usage.note")}</CardDescription>
          </div>
          <div className="flex flex-wrap gap-3">
            <label className="grid gap-1 text-xs font-medium text-text-secondary">
              {t("usage.days")}
              <Select
                aria-label={t("usage.days")}
                className="min-w-28"
                value={String(days)}
                onChange={(event) => update("window", event.target.value)}
              >
                {[7, 14, 30, 90].map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </Select>
            </label>
            <label className="grid gap-1 text-xs font-medium text-text-secondary">
              {t("usage.capability")}
              <Select
                aria-label={t("usage.capability")}
                className="min-w-48"
                value={selectedCapability}
                onChange={(event) => update("capability", event.target.value)}
              >
                <option value="all">{t("usage.allCapabilities")}</option>
                {capabilities.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </Select>
            </label>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {query.isError ? (
            <p role="alert" className="text-sm text-danger">{t("usage.loadError")}</p>
          ) : null}
          {!query.isLoading && !query.isError ? (
            <DataTable
              caption={t("usage.table")}
              columns={columns}
              rows={rows}
              rowKey={(row) => `${row.day}-${row.capability}`}
              emptyTitle={t("usage.empty")}
            />
          ) : null}
        </CardContent>
      </Card>

      {!query.isLoading && !query.isError ? <TokenTrend rows={query.data?.daily_totals ?? []} /> : null}
    </div>
  );
}

function SummaryMetric({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return (
    <div className="rounded-[var(--radius-panel)] border border-border bg-surface px-4 py-4 shadow-[var(--shadow-panel)]">
      <p className="text-xs font-medium uppercase tracking-[0.08em] text-text-secondary">{label}</p>
      <p className={compact ? "mt-2 text-base font-semibold text-text-primary" : "mt-2 text-3xl font-semibold tabular-nums text-text-primary"}>
        {value}
      </p>
    </div>
  );
}

function TokenTrend({ rows }: { rows: { day: string; tokens: number; calls: number }[] }) {
  const { t, locale } = useI18n();
  const peak = Math.max(...rows.map((row) => row.tokens), 1);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("usage.trend")}</CardTitle>
        <CardDescription>{t("usage.trendHelp")}</CardDescription>
      </CardHeader>
      <CardContent>
        <section aria-label={t("usage.trend")} className="space-y-3">
          {rows.length === 0 ? (
            <p className="text-sm text-text-secondary">{t("usage.empty")}</p>
          ) : rows.map((row) => (
            <div key={row.day} className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-3 text-sm">
              <span className="font-mono text-xs text-text-secondary">{row.day}</span>
              <span className="h-2 overflow-hidden rounded-full bg-surface-subtle" aria-hidden="true">
                <span
                  className="block h-full rounded-full bg-interactive"
                  style={{ width: `${Math.max(4, (row.tokens / peak) * 100)}%` }}
                />
              </span>
              <span className="min-w-20 text-right font-medium tabular-nums">
                {formatNumber(row.tokens, locale)}
              </span>
            </div>
          ))}
        </section>
      </CardContent>
    </Card>
  );
}
