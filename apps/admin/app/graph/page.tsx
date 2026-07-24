"use client";

import { useState } from "react";

import { PageShell } from "@/components/page-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useEntityGraph } from "@/lib/api/hooks";
import { useI18n } from "@/lib/i18n/context";

const PAGE = 25;

export default function GraphPage() {
  const { t } = useI18n();
  return (
    <PageShell title={t("graph.title")} subtitle={t("graph.subtitle")}>
      {(project) => <GraphView project={project} />}
    </PageShell>
  );
}

function GraphView({ project }: { project: string }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [name, setName] = useState("");
  const [offset, setOffset] = useState(0);
  const { data, isFetching } = useEntityGraph(project, name, offset, PAGE);

  function search() {
    setOffset(0);
    setName(draft.trim());
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("graph.title")}</CardTitle>
        <CardDescription>{t("graph.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Input
            aria-label={t("graph.search")}
            placeholder={t("graph.searchPlaceholder")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") search();
            }}
          />
          <Button size="sm" onClick={search}>
            {t("graph.open")}
          </Button>
        </div>

        {name && !isFetching && !data ? (
          <p className="text-sm text-neutral-500">{t("graph.notFound")}</p>
        ) : null}

        {data ? (
          <>
            <div className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
              <p className="text-xs text-neutral-500">{t("graph.center")}</p>
              <p className="font-medium">
                {data.center.name}{" "}
                <span className="text-neutral-400">({data.center.type})</span>
                {data.center.anchored ? (
                  <span className="ml-2 rounded bg-emerald-100 px-1 text-xs text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200">
                    {t("graph.anchored")}
                  </span>
                ) : null}
              </p>
            </div>

            <div>
              <p className="mb-1 text-sm text-neutral-500">
                {t("graph.showing", { shown: data.neighbors.length, total: data.total })}
              </p>
              {data.neighbors.length === 0 ? (
                <p className="text-sm text-neutral-400">{t("common.none")}</p>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead className="text-neutral-500">
                    <tr>
                      <th className="py-1">{t("graph.neighbors")}</th>
                      <th>{t("graph.type")}</th>
                      <th>{t("graph.relation")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.neighbors.map((neighbor) => {
                      const edge = data.edges.find(
                        (e) => e.source === neighbor.id || e.target === neighbor.id,
                      );
                      return (
                        <tr
                          key={neighbor.id}
                          className="border-t border-neutral-100 dark:border-neutral-800"
                        >
                          <td className="py-1">
                            <button
                              className="underline"
                              onClick={() => {
                                setDraft(neighbor.name);
                                setOffset(0);
                                setName(neighbor.name);
                              }}
                            >
                              {neighbor.name}
                            </button>
                          </td>
                          <td>{neighbor.type}</td>
                          <td className="font-mono text-xs">{edge?.type ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE))}
              >
                {t("graph.prev")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={offset + PAGE >= data.total}
                onClick={() => setOffset(offset + PAGE)}
              >
                {t("graph.next")}
              </Button>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
