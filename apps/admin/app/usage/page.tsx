"use client";

import { useState } from "react";

import { PageShell } from "@/components/page-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useUsage } from "@/lib/api/hooks";
import { useI18n } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";

export default function UsagePage() {
  const { t } = useI18n();
  return (
    <PageShell title={t("usage.title")} subtitle={t("usage.subtitle")}>
      {(project) => <UsageTable project={project} />}
    </PageShell>
  );
}

function UsageTable({ project }: { project: string }) {
  const { t, locale } = useI18n();
  const [days, setDays] = useState(7);
  const { data } = useUsage(project, days);
  const rows = data?.usage ?? [];
  const totalTokens = rows.reduce((sum, r) => sum + r.tokens, 0);
  const totalCalls = rows.reduce((sum, r) => sum + r.calls, 0);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle>{t("usage.title")}</CardTitle>
          <CardDescription>{t("usage.note")}</CardDescription>
        </div>
        <label className="flex items-center gap-2 text-sm">
          {t("usage.days")}
          <select
            aria-label={t("usage.days")}
            className="h-8 rounded-md border border-neutral-300 bg-transparent px-2 dark:border-neutral-700"
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          >
            {[7, 14, 30, 90].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-neutral-500">{t("usage.empty")}</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-neutral-500">
              <tr>
                <th className="py-1">{t("usage.day")}</th>
                <th>{t("usage.capability")}</th>
                <th className="text-right">{t("usage.tokens")}</th>
                <th className="text-right">{t("usage.calls")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.day}-${row.capability}`}
                  className="border-t border-neutral-100 dark:border-neutral-800"
                >
                  <td className="py-1 font-mono text-xs">{row.day}</td>
                  <td>{row.capability}</td>
                  <td className="text-right">{formatNumber(row.tokens, locale)}</td>
                  <td className="text-right">{formatNumber(row.calls, locale)}</td>
                </tr>
              ))}
              <tr className="border-t border-neutral-300 font-medium dark:border-neutral-600">
                <td className="py-1">{t("usage.total")}</td>
                <td />
                <td className="text-right">{formatNumber(totalTokens, locale)}</td>
                <td className="text-right">{formatNumber(totalCalls, locale)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
