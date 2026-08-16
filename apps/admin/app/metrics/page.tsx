"use client";

import { PageShell } from "@/components/page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useProductMetrics } from "@/lib/api/hooks";
import { useI18n } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";

export default function MetricsPage() {
  const { t } = useI18n();
  return (
    <PageShell title={t("metrics.title")} subtitle={t("metrics.subtitle")}>
      {(project) => <MetricsGrid project={project} />}
    </PageShell>
  );
}

function MetricsGrid({ project }: { project: string }) {
  const { t, locale } = useI18n();
  const { data } = useProductMetrics(project);
  const num = (value: number | null | undefined) =>
    value === null || value === undefined ? "—" : formatNumber(value, locale);
  const pct = (value: number | null | undefined) =>
    value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`;

  const tokens = data?.health.tokens_by_capability ?? {};

  return (
    <section className="grid gap-4 md:grid-cols-2">
      <Family title={t("metrics.adoption")}>
        <Row label={t("metrics.recalls")} value={num(data?.adoption.recalls)} />
        <Row label={t("metrics.activePrincipals")} value={num(data?.adoption.active_principals)} />
      </Family>
      <Family title={t("metrics.quality")}>
        <Row label={t("metrics.abstentionRate")} value={pct(data?.quality.abstention_rate)} />
        <Row label={t("metrics.huntsAnswered")} value={pct(data?.quality.hunts_answered_pct)} />
      </Family>
      <Family title={t("metrics.knowledge")}>
        <Row label={t("metrics.claims")} value={num(data?.knowledge.claims)} />
        <Row label={t("metrics.disputed")} value={num(data?.knowledge.disputed)} />
        <Row label={t("metrics.openGaps")} value={num(data?.knowledge.open_gaps)} />
      </Family>
      <Family title={t("metrics.health")}>
        <Row label={t("metrics.extractionErrors")} value={num(data?.health.extraction_errors)} />
        <Row label={t("metrics.p95")} value={num(data?.health.recall_p95_ms)} />
        <div className="pt-2">
          <p className="text-xs text-text-secondary">{t("metrics.tokensByCapability")}</p>
          {Object.keys(tokens).length === 0 ? (
            <p className="text-sm text-text-secondary">—</p>
          ) : (
            Object.entries(tokens).map(([capability, value]) => (
              <Row key={capability} label={capability} value={num(value)} />
            ))
          )}
        </div>
      </Family>
    </section>
  );
}

function Family({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">{children}</CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-text-secondary">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
