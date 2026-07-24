"use client";

import { useState } from "react";

import { PageShell } from "@/components/page-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAudit } from "@/lib/api/hooks";
import type { AuditFilters } from "@/lib/api/types";
import { useI18n } from "@/lib/i18n/context";
import { formatDateTime } from "@/lib/i18n/format";

export default function AuditPage() {
  const { t } = useI18n();
  return (
    <PageShell title={t("audit.title")} subtitle={t("audit.subtitle")}>
      {(project) => <AuditView project={project} />}
    </PageShell>
  );
}

function toQuery(project: string, filters: AuditFilters): string {
  const params = new URLSearchParams({ project });
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  return params.toString();
}

function AuditView({ project }: { project: string }) {
  const { t, locale } = useI18n();
  const [draft, setDraft] = useState<AuditFilters>({});
  const [applied, setApplied] = useState<AuditFilters>({});
  const { data } = useAudit(project, applied);
  const rows = data?.audit ?? [];

  function set<K extends keyof AuditFilters>(key: K, value: AuditFilters[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("audit.title")}</CardTitle>
        <CardDescription>{t("audit.privacyNote")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Input
            aria-label={t("audit.action")}
            placeholder={t("audit.action")}
            value={draft.action ?? ""}
            onChange={(e) => set("action", e.target.value)}
          />
          <Input
            aria-label={t("audit.tool")}
            placeholder={t("audit.tool")}
            value={draft.tool ?? ""}
            onChange={(e) => set("tool", e.target.value)}
          />
          <select
            aria-label={t("audit.principalType")}
            className="h-9 rounded-md border border-neutral-300 bg-transparent px-2 text-sm dark:border-neutral-700"
            value={draft.principal_type ?? ""}
            onChange={(e) => set("principal_type", e.target.value || undefined)}
          >
            <option value="">{t("audit.principalType")}</option>
            <option value="human">human</option>
            <option value="agent">agent</option>
          </select>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.denied ?? false}
              onChange={(e) => set("denied", e.target.checked || undefined)}
            />
            {t("audit.denied")}
          </label>
          <Input
            aria-label={t("audit.since")}
            type="date"
            value={draft.since ?? ""}
            onChange={(e) => set("since", e.target.value || undefined)}
          />
          <Input
            aria-label={t("audit.until")}
            type="date"
            value={draft.until ?? ""}
            onChange={(e) => set("until", e.target.value || undefined)}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setApplied(draft)}>
            {t("audit.apply")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setDraft({});
              setApplied({});
            }}
          >
            {t("audit.clear")}
          </Button>
          <a
            className="ml-auto text-sm underline"
            href={`/api/proxy/api/v1/admin/audit/export?${toQuery(project, applied)}`}
          >
            {t("common.export")}
          </a>
        </div>

        {rows.length === 0 ? (
          <p className="text-sm text-neutral-500">{t("audit.empty")}</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-neutral-500">
              <tr>
                <th className="py-1">{t("audit.ts")}</th>
                <th>{t("audit.principal")}</th>
                <th>{t("audit.action")}</th>
                <th>{t("audit.tool")}</th>
                <th>{t("audit.query")}</th>
                <th className="text-right">{t("audit.results")}</th>
                <th>{t("audit.denied")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-neutral-100 dark:border-neutral-800">
                  <td className="py-1 whitespace-nowrap">{formatDateTime(row.ts, locale)}</td>
                  <td>
                    {row.principal_type}
                    <span className="text-neutral-400">:{(row.principal_id ?? "").slice(0, 8)}</span>
                  </td>
                  <td>{row.action}</td>
                  <td>{row.tool ?? "—"}</td>
                  <td className="font-mono text-xs">{row.query_text ?? row.query_hash ?? "—"}</td>
                  <td className="text-right">{row.result_count ?? 0}</td>
                  <td>{row.denied ? t("common.yes") : t("common.no")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
