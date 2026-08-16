"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { PageShell } from "@/components/page-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type DataColumn } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/ui/pagination";
import { Select } from "@/components/ui/select";
import { useAudit } from "@/lib/api/hooks";
import type { AuditFilters, AuditRow } from "@/lib/api/types";
import { useI18n } from "@/lib/i18n/context";
import { formatDateTime } from "@/lib/i18n/format";

const PAGE_SIZE = 50;

export default function AuditPage() {
  const { t } = useI18n();
  return (
    <PageShell title={t("audit.title")} subtitle={t("audit.subtitle")}>
      {(project) => <AuditRoute project={project} />}
    </PageShell>
  );
}

function AuditRoute({ project }: { project: string }) {
  const searchParams = useSearchParams();
  return <AuditWorkspace key={searchParams.toString()} project={project} />;
}

function filtersFrom(params: URLSearchParams): AuditFilters {
  const filters: AuditFilters = {};
  for (const key of ["action", "tool", "principal_type", "principal_id", "since", "until"] as const) {
    const value = params.get(key);
    if (value) filters[key] = value;
  }
  if (params.get("denied") === "true") filters.denied = true;
  return filters;
}

function offsetFrom(params: URLSearchParams): number {
  const value = Number(params.get("offset"));
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function serialized(filters: AuditFilters, offset: number, includeOffset = true) {
  const params = new URLSearchParams();
  if (filters.action) params.set("action", filters.action);
  if (filters.tool) params.set("tool", filters.tool);
  if (filters.principal_type) params.set("principal_type", filters.principal_type);
  if (filters.principal_id) params.set("principal_id", filters.principal_id);
  if (filters.denied) params.set("denied", "true");
  if (filters.since) params.set("since", filters.since);
  if (filters.until) params.set("until", filters.until);
  if (includeOffset) params.set("offset", String(offset));
  return params;
}

function AuditWorkspace({ project }: { project: string }) {
  const { t, locale } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const applied = filtersFrom(searchParams);
  const offset = offsetFrom(searchParams);
  const [draft, setDraft] = useState<AuditFilters>(() => applied);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const query = useAudit(project, applied, PAGE_SIZE, offset);
  const rows = query.data?.audit ?? [];
  const selected = rows.find((row) => String(row.id) === selectedId) ?? null;
  const exportFilters = serialized(applied, 0, false).toString();

  function set<K extends keyof AuditFilters>(key: K, value: AuditFilters[K]) {
    setDraft((previous) => ({ ...previous, [key]: value }));
  }

  function writeUrl(filters: AuditFilters, nextOffset: number) {
    router.replace(`${pathname}?${serialized(filters, nextOffset).toString()}`, { scroll: false });
  }

  const columns: DataColumn<AuditRow>[] = [
    {
      key: "time",
      label: t("audit.ts"),
      render: (row) => <span className="whitespace-nowrap text-xs">{formatDateTime(row.ts, locale)}</span>,
    },
    {
      key: "principal",
      label: t("audit.principal"),
      render: (row) => (
        <span>{row.principal_type ?? "—"}<span className="text-text-secondary">:{row.principal_id?.slice(0, 8) ?? "—"}</span></span>
      ),
    },
    { key: "action", label: t("audit.action"), render: (row) => row.action },
    { key: "tool", label: t("audit.tool"), render: (row) => row.tool ?? "—" },
    {
      key: "query",
      label: t("audit.query"),
      render: (row) => <span className="font-mono text-xs">{row.query_text ?? row.query_hash ?? "—"}</span>,
    },
    {
      key: "results",
      label: t("audit.results"),
      align: "right",
      render: (row) => <span data-testid="audit-result-count">{row.result_count ?? "—"}</span>,
    },
    {
      key: "decision",
      label: t("audit.deniedFilter"),
      render: (row) => <Badge tone={row.denied ? "danger" : "success"}>{row.denied ? t("common.yes") : t("common.no")}</Badge>,
    },
    {
      key: "inspect",
      label: t("audit.actions"),
      render: (row) => (
        <Button
          aria-label={t("audit.inspect", { id: String(row.id) })}
          size="sm"
          variant="outline"
          onClick={() => setSelectedId(String(row.id))}
        >
          {t("audit.detail")}
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>{t("audit.title")}</CardTitle>
          <CardDescription>{t("audit.privacyNote")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <section aria-label={t("audit.appliedFilters")} className="flex min-h-7 flex-wrap gap-2">
            {applied.action ? <Badge tone="info">{t("audit.actionChip", { value: applied.action })}</Badge> : null}
            {applied.tool ? <Badge tone="info">{t("audit.toolChip", { value: applied.tool })}</Badge> : null}
            {applied.principal_type ? <Badge tone="info">{t("audit.principalTypeChip", { value: applied.principal_type })}</Badge> : null}
            {applied.principal_id ? <Badge tone="info">{t("audit.principalIdChip", { value: applied.principal_id })}</Badge> : null}
            {applied.since ? <Badge tone="info">{t("audit.sinceChip", { value: applied.since })}</Badge> : null}
            {applied.until ? <Badge tone="info">{t("audit.untilChip", { value: applied.until })}</Badge> : null}
            {applied.denied ? <Badge tone="danger">{t("audit.denied")}</Badge> : null}
          </section>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Input aria-label={t("audit.action")} placeholder={t("audit.action")} value={draft.action ?? ""} onChange={(event) => set("action", event.target.value || undefined)} />
            <Input aria-label={t("audit.tool")} placeholder={t("audit.tool")} value={draft.tool ?? ""} onChange={(event) => set("tool", event.target.value || undefined)} />
            <Select aria-label={t("audit.principalType")} value={draft.principal_type ?? ""} onChange={(event) => set("principal_type", event.target.value || undefined)}>
              <option value="">{t("audit.principalType")}</option>
              <option value="human">human</option>
              <option value="agent">agent</option>
            </Select>
            <Input aria-label={t("audit.principalId")} placeholder={t("audit.principalId")} value={draft.principal_id ?? ""} onChange={(event) => set("principal_id", event.target.value || undefined)} />
            <Input aria-label={t("audit.since")} type="date" value={draft.since ?? ""} onChange={(event) => set("since", event.target.value || undefined)} />
            <Input aria-label={t("audit.until")} type="date" value={draft.until ?? ""} onChange={(event) => set("until", event.target.value || undefined)} />
            <label className="flex min-h-11 items-center gap-2 rounded-[var(--radius-panel)] border border-border px-3 text-sm">
              <input type="checkbox" checked={draft.denied ?? false} onChange={(event) => set("denied", event.target.checked || undefined)} />
              {t("audit.deniedFilter")}
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => writeUrl(draft, 0)}>{t("audit.apply")}</Button>
            <Button size="sm" variant="outline" onClick={() => { setDraft({}); writeUrl({}, 0); }}>{t("audit.clear")}</Button>
            <a className="ml-auto text-sm font-medium text-interactive underline-offset-4 hover:underline" href={`/api/proxy/api/v1/admin/audit/export?project=${encodeURIComponent(project)}${exportFilters ? `&${exportFilters}` : ""}`}>
              {t("common.export")}
            </a>
          </div>

          {query.isError ? <p role="alert" className="text-sm text-danger">{t("audit.loadError")}</p> : null}
          {!query.isLoading && !query.isError ? (
            <DataTable caption={t("audit.events")} columns={columns} rows={rows} rowKey={(row) => row.id} emptyTitle={t("audit.empty")} />
          ) : null}

          <Pagination
            label={t("audit.pagePosition", { start: rows.length ? offset + 1 : 0, end: offset + rows.length })}
            previousLabel={t("audit.previousPage")}
            nextLabel={t("audit.nextPage")}
            hasPrevious={offset > 0}
            hasNext={query.data?.next_offset !== null && query.data?.next_offset !== undefined}
            onPrevious={() => writeUrl(applied, Math.max(0, offset - PAGE_SIZE))}
            onNext={() => writeUrl(applied, query.data?.next_offset ?? offset)}
          />
        </CardContent>
      </Card>

      {selected ? <AuditDetail row={selected} /> : null}
    </div>
  );
}

function AuditDetail({ row }: { row: AuditRow }) {
  const { t } = useI18n();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("audit.detail")}</CardTitle>
      </CardHeader>
      <CardContent>
        <section aria-label={t("audit.detail")} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Detail label={t("audit.eventId")} value={String(row.id)} mono />
          <Detail label={t("audit.trace")} value={row.trace_id ?? "—"} mono />
          <Detail label={t("audit.topics")} value={row.topics_used.length ? row.topics_used.join(", ") : "—"} />
          <Detail label={t("audit.duration")} value={row.duration_ms === null ? "—" : `${row.duration_ms} ms`} />
          <div className="sm:col-span-2 lg:col-span-4">
            <p className="text-xs font-medium uppercase tracking-[0.08em] text-text-secondary">{t("audit.queryText")}</p>
            <p className="mt-1 break-all text-sm">{row.query_text ?? t("audit.queryNotRetained")}</p>
            {row.query_hash ? <p className="mt-1 break-all font-mono text-xs text-text-secondary">{row.query_hash}</p> : null}
          </div>
        </section>
      </CardContent>
    </Card>
  );
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-[0.08em] text-text-secondary">{label}</p>
      <p className={mono ? "mt-1 break-all font-mono text-xs" : "mt-1 text-sm"}>{value}</p>
    </div>
  );
}
