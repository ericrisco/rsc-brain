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
import { useEntityGraph } from "@/lib/api/hooks";
import type { GraphEdgeView, GraphNodeView, Neighborhood } from "@/lib/api/types";
import { useI18n } from "@/lib/i18n/context";

const PAGE = 25;

export default function GraphPage() {
  const { t } = useI18n();
  return (
    <PageShell title={t("graph.title")} subtitle={t("graph.subtitle")}>
      {(project) => <GraphRoute project={project} />}
    </PageShell>
  );
}

function GraphRoute({ project }: { project: string }) {
  const searchParams = useSearchParams();
  return <GraphWorkspace key={searchParams.toString()} project={project} />;
}

function safeOffset(value: string | null) {
  const offset = Number(value);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}

function GraphWorkspace({ project }: { project: string }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const name = searchParams.get("entity")?.trim() ?? "";
  const offset = safeOffset(searchParams.get("offset"));
  const trail = (searchParams.get("trail") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const [draft, setDraft] = useState(name);
  const query = useEntityGraph(project, name, offset, PAGE);
  const neighborhood = query.data;

  function navigate(entity: string, nextOffset: number, nextTrail: string[]) {
    const params = new URLSearchParams();
    params.set("entity", entity);
    params.set("offset", String(nextOffset));
    if (nextTrail.length) params.set("trail", nextTrail.join(","));
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  function search() {
    const entity = draft.trim();
    if (entity) navigate(entity, 0, []);
  }

  return (
    <Card>
      <CardHeader className="gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <CardTitle>{t("graph.title")}</CardTitle>
          <CardDescription>{t("graph.subtitle")}</CardDescription>
        </div>
        <div className="flex w-full max-w-xl gap-2">
          <Input
            aria-label={t("graph.search")}
            placeholder={t("graph.searchPlaceholder")}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") search(); }}
          />
          <Button size="sm" onClick={search}>{t("graph.open")}</Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {trail.length ? (
          <nav aria-label={t("graph.trail")} className="flex flex-wrap items-center gap-1 text-xs text-text-secondary">
            {trail.map((item, index) => (
              <span key={`${item}-${index}`} className="flex items-center gap-1">
                {index ? <span aria-hidden="true">/</span> : null}
                <button className="rounded px-1 py-0.5 hover:bg-surface-subtle hover:text-text-primary" onClick={() => navigate(item, 0, trail.slice(0, index))}>
                  {item}
                </button>
              </span>
            ))}
            <span aria-hidden="true">/</span>
            <span className="font-medium text-text-primary">{name}</span>
          </nav>
        ) : null}

        {query.isError ? <p role="alert" className="text-sm text-danger">{t("graph.loadError")}</p> : null}
        {name && !query.isFetching && !query.isError && !query.data ? (
          <p className="text-sm text-text-secondary">{t("graph.notFound")}</p>
        ) : null}
        {neighborhood ? (
          <NeighborhoodView
            data={neighborhood}
            onFollow={(neighbor) => navigate(neighbor.name, 0, [...trail, neighborhood.center.name])}
            onPage={(nextOffset) => navigate(name, nextOffset, trail)}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function NeighborhoodView({
  data,
  onFollow,
  onPage,
}: {
  data: Neighborhood;
  onFollow: (neighbor: GraphNodeView) => void;
  onPage: (offset: number) => void;
}) {
  const { t } = useI18n();

  function edgeFor(neighbor: GraphNodeView): GraphEdgeView | undefined {
    return data.edges.find((edge) =>
      (edge.source === data.center.id && edge.target === neighbor.id)
      || (edge.target === data.center.id && edge.source === neighbor.id));
  }

  const columns: DataColumn<GraphNodeView>[] = [
    {
      key: "entity",
      label: t("graph.neighbors"),
      render: (neighbor) => (
        <button
          aria-label={t("graph.follow", { name: neighbor.name })}
          className="font-medium text-interactive underline-offset-4 hover:underline"
          onClick={() => onFollow(neighbor)}
        >
          {neighbor.name}
        </button>
      ),
    },
    { key: "type", label: t("graph.type"), render: (neighbor) => neighbor.type },
    {
      key: "relation",
      label: t("graph.relation"),
      render: (neighbor) => <span className="font-mono text-xs">{edgeFor(neighbor)?.type ?? "—"}</span>,
    },
    {
      key: "direction",
      label: t("graph.direction"),
      render: (neighbor) => {
        const edge = edgeFor(neighbor);
        if (!edge) return "—";
        return edge.source === data.center.id ? t("graph.outgoing") : t("graph.incoming");
      },
    },
  ];

  return (
    <div className="space-y-5">
      <section aria-label={t("graph.details")} className="rounded-[var(--radius-panel)] border border-border bg-surface-subtle/45 p-4">
        <p className="text-xs font-medium uppercase tracking-[0.08em] text-text-secondary">{t("graph.center")}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-xl font-semibold">{data.center.name}</span>
          <Badge>{data.center.type}</Badge>
          {data.center.anchored ? <Badge tone="success">{t("graph.anchoredIdentity")}</Badge> : null}
        </div>
      </section>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-text-secondary">
          <span>{t("graph.showing", { shown: data.neighbors.length, total: data.total })}</span>
          <span>{t("graph.pageLimit")}</span>
        </div>
        <DataTable
          caption={t("graph.neighborhood")}
          columns={columns}
          rows={data.neighbors}
          rowKey={(neighbor) => neighbor.id}
          emptyTitle={t("common.none")}
        />
      </div>

      <Pagination
        label={t("graph.pagePosition", {
          start: data.neighbors.length ? data.offset + 1 : 0,
          end: data.offset + data.neighbors.length,
          total: data.total,
        })}
        previousLabel={t("graph.previousPage")}
        nextLabel={t("graph.nextPage")}
        hasPrevious={data.offset > 0}
        hasNext={data.offset + data.limit < data.total}
        onPrevious={() => onPage(Math.max(0, data.offset - PAGE))}
        onNext={() => onPage(data.offset + PAGE)}
      />
    </div>
  );
}
