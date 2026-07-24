"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useMe, useResolveChunk, useResolveMerge, useReviewQueue } from "@/lib/api/hooks";

/** SPEC-21 — the unified needs_review queue: one inbox over ambiguous tables, guardrail-flagged
 * chunks, quarantined agent submissions, low-confidence entity merges, and agent correction
 * suggestions. Chunk + merge items resolve inline (server enforces the minimum role). */
export default function ReviewPage() {
  const router = useRouter();
  const { data: me, isError } = useMe();
  const [project, setProject] = useState("");

  useEffect(() => {
    if (isError) router.replace("/login");
  }, [isError, router]);
  useEffect(() => {
    if (me && !project && me.memberships[0]) setProject(me.memberships[0].project);
  }, [me, project]);

  if (!me) return <main className="p-6 text-sm text-neutral-500">Loading…</main>;

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Review queue</h1>
        <select
          aria-label="Project"
          className="h-9 rounded-md border border-neutral-300 bg-transparent px-2 text-sm dark:border-neutral-700"
          value={project}
          onChange={(e) => setProject(e.target.value)}
        >
          {me.memberships.map((m) => (
            <option key={m.project} value={m.project}>
              {m.project}
            </option>
          ))}
        </select>
      </header>
      {project ? <Queue project={project} /> : <p className="text-sm text-neutral-500">Select a project.</p>}
    </main>
  );
}

function Queue({ project }: { project: string }) {
  const { data } = useReviewQueue(project);
  const resolveChunk = useResolveChunk(project);
  const resolveMerge = useResolveMerge(project);
  const items = data?.items ?? [];
  const counts = data?.counts ?? {};

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pending items</CardTitle>
        <CardDescription>
          {Object.entries(counts)
            .map(([source, n]) => `${source}: ${n}`)
            .join(" · ") || "empty"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {items.length === 0 && <p className="text-neutral-500">Nothing to review.</p>}
        {items.map((item) => {
          const isChunk = ["ambiguous_table", "guardrail", "agent_submission"].includes(item.source);
          const isMerge = item.source === "entity_merge";
          return (
            <div
              key={`${item.source}:${item.id}`}
              className="flex items-center justify-between gap-3 border-b py-1 dark:border-neutral-800"
            >
              <span className="min-w-0 flex-1 truncate">
                <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-xs dark:bg-neutral-800">
                  {item.source}
                </span>{" "}
                {item.preview}
              </span>
              {(isChunk || isMerge) && (
                <span className="flex shrink-0 gap-1">
                  <Button
                    variant="outline"
                    onClick={() =>
                      isChunk
                        ? resolveChunk.mutate({ chunkId: item.id, approve: true })
                        : resolveMerge.mutate({ proposalId: item.id, approve: true })
                    }
                  >
                    Approve
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      isChunk
                        ? resolveChunk.mutate({ chunkId: item.id, approve: false })
                        : resolveMerge.mutate({ proposalId: item.id, approve: false })
                    }
                  >
                    Reject
                  </Button>
                </span>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
