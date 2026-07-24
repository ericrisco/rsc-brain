"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  useActivity,
  useApproveDoc,
  useHealth,
  useMe,
  usePendingDocs,
  useRecalls,
} from "@/lib/api/hooks";

export default function ObservabilityPage() {
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
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Observability</h1>
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
      {project ? (
        <>
          <ActivityCards project={project} />
          <RecallStream project={project} />
          <ApprovalQueue project={project} />
        </>
      ) : (
        <p className="text-sm text-neutral-500">Select a project.</p>
      )}
    </main>
  );
}

function ActivityCards({ project }: { project: string }) {
  const { data: activity } = useActivity(project);
  const { data: health } = useHealth(project);
  return (
    <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
      <Metric title="Recalls" value={activity?.recalls ?? "—"} />
      <Metric title="Abstained / denied" value={activity?.denied ?? "—"} />
      <Metric title="Active principals" value={activity?.active_principals ?? "—"} />
      <Metric title="p95 latency (ms)" value={activity?.p95_duration_ms ?? "—"} />
      <Metric title="Pending approval" value={health?.pending_approval ?? "—"} />
      <Metric title="Ingest errors" value={health?.ingest_errors ?? "—"} />
    </section>
  );
}

function Metric({ title, value }: { title: string; value: number | string }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}

function RecallStream({ project }: { project: string }) {
  const [principal, setPrincipal] = useState<string>("");
  const { data } = useRecalls(project, principal ? { principal_type: principal } : {});
  const rows = data?.recalls ?? [];
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle>Recall stream</CardTitle>
          <CardDescription>Live queries (auto-refreshing)</CardDescription>
        </div>
        <select
          aria-label="Principal filter"
          className="h-8 rounded-md border border-neutral-300 bg-transparent px-2 text-sm dark:border-neutral-700"
          value={principal}
          onChange={(e) => setPrincipal(e.target.value)}
        >
          <option value="">All principals</option>
          <option value="human">Humans</option>
          <option value="agent">Agents</option>
        </select>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-neutral-500">No queries yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-neutral-500">
              <tr>
                <th className="py-1">Query</th>
                <th>Principal</th>
                <th>Results</th>
                <th>ms</th>
                <th>Denied</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-neutral-100 dark:border-neutral-800">
                  <td className="py-1 font-mono text-xs">{r.query_text ?? r.query_hash}</td>
                  <td>{r.principal_type}</td>
                  <td>{r.result_count ?? 0}</td>
                  <td>{r.duration_ms ?? "—"}</td>
                  <td>{r.denied ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

function ApprovalQueue({ project }: { project: string }) {
  const { data } = usePendingDocs(project);
  const approve = useApproveDoc(project);
  const docs = data?.documents ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Approval queue (D13)</CardTitle>
        <CardDescription>{docs.length} pending</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {docs.length === 0 ? (
          <p className="text-sm text-neutral-500">Nothing pending.</p>
        ) : (
          docs.map((doc) => (
            <PendingRow
              key={doc.document_id}
              documentId={doc.document_id}
              title={doc.title ?? doc.document_id}
              preview={doc.preview}
              tags={doc.proposed_tags}
              onApprove={(tags) =>
                approve.mutate({ documentId: doc.document_id, tags })
              }
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function PendingRow({
  title,
  preview,
  tags,
  onApprove,
}: {
  documentId: string;
  title: string;
  preview: string;
  tags: string[];
  onApprove: (tags: string[]) => void;
}) {
  const [edited, setEdited] = useState(tags.join(", "));
  return (
    <div className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <p className="font-medium">{title}</p>
      <p className="mt-1 line-clamp-2 text-sm text-neutral-500">{preview}</p>
      <div className="mt-2 flex items-center gap-2">
        <Input
          aria-label="Proposed tags"
          value={edited}
          onChange={(e) => setEdited(e.target.value)}
        />
        <Button
          onClick={() =>
            onApprove(
              edited
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
            )
          }
        >
          Approve
        </Button>
      </div>
    </div>
  );
}
