"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  useCorrectionMetrics,
  useCorrections,
  useDisputed,
  useGaps,
  useHunts,
  useMe,
  usePromoteGap,
  useResolutions,
  useRevertCorrection,
} from "@/lib/api/hooks";

/** SPEC-19 — the living-knowledge view: gaps, hunts, disputed claims + resolutions, and the
 * Learning-Layer corrections feed with the pending queue + revert. Read-only except the two
 * actions the gate requires (promote a gap, revert a correction); the server enforces authz. */
export default function KnowledgePage() {
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
        <h1 className="text-xl font-semibold">Living knowledge</h1>
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
          <Metrics project={project} />
          <Gaps project={project} />
          <Hunts project={project} />
          <Disputed project={project} />
          <Resolutions project={project} />
          <Corrections project={project} />
        </>
      ) : (
        <p className="text-sm text-neutral-500">Select a project.</p>
      )}
    </main>
  );
}

function Metrics({ project }: { project: string }) {
  const { data } = useCorrectionMetrics(project);
  if (!data) return null;
  const cards: [string, string][] = [
    ["Corrections", String(data.total)],
    ["Applied", String(data.applied)],
    ["Routed to hunt", String(data.routed_hunt)],
    ["Rejected", String(data.rejected)],
    ["Revert rate", `${Math.round(data.revert_rate * 100)}%`],
    ["Correction wars", String(data.correction_wars)],
    ["Ownership coverage", `${Math.round(data.ownership_coverage * 100)}%`],
  ];
  return (
    <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cards.map(([label, value]) => (
        <Card key={label}>
          <CardHeader className="pb-1">
            <CardDescription>{label}</CardDescription>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{value}</CardContent>
        </Card>
      ))}
    </section>
  );
}

function Gaps({ project }: { project: string }) {
  const [agents, setAgents] = useState(false);
  const { data } = useGaps(project, agents);
  const promote = usePromoteGap(project);
  const gaps = data?.gaps ?? [];
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle>Gaps</CardTitle>
          <CardDescription>{agents ? "Agent gaps (never auto-hunted)" : "Human gaps"}</CardDescription>
        </div>
        <Button variant="outline" onClick={() => setAgents((v) => !v)}>
          {agents ? "Show human gaps" : "Show agent gaps"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {gaps.length === 0 && <p className="text-neutral-500">No gaps.</p>}
        {gaps.map((g) => (
          <div key={g.id} className="flex items-center justify-between border-b py-1 dark:border-neutral-800">
            <span>
              <span className="font-mono text-xs text-neutral-500">×{g.count}</span>{" "}
              {g.query_text ?? "(query text hidden)"} <span className="text-neutral-400">{g.topics.join(", ")}</span>
            </span>
            {agents && (
              <Button variant="outline" onClick={() => promote.mutate(g.id)} disabled={promote.isPending}>
                Promote to hunt
              </Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function Hunts({ project }: { project: string }) {
  const { data } = useHunts(project);
  const hunts = data?.hunts ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Hunts</CardTitle>
        <CardDescription>Live state machine (FR-6.3)</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        {hunts.length === 0 && <p className="text-neutral-500">No hunts.</p>}
        {hunts.map((h) => (
          <div key={h.id} className="flex items-center justify-between border-b py-1 dark:border-neutral-800">
            <span>
              <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-xs dark:bg-neutral-800">{h.state}</span>{" "}
              <span className="text-neutral-400">{h.type}</span> {h.question ?? ""}
            </span>
            <span className="text-xs text-neutral-400">{h.retries > 0 ? `retries ${h.retries}` : ""}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function Disputed({ project }: { project: string }) {
  const { data } = useDisputed(project);
  const claims = data?.claims ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Disputed claims</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        {claims.length === 0 && <p className="text-neutral-500">Nothing disputed.</p>}
        {claims.map((c) => (
          <div key={c.id} className="border-b py-1 dark:border-neutral-800">
            {c.text} <span className="text-neutral-400">cred {c.credibility.toFixed(2)}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function Resolutions({ project }: { project: string }) {
  const { data } = useResolutions(project);
  const resolutions = data?.resolutions ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Contradiction resolutions</CardTitle>
        <CardDescription>Who won, by what score</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {resolutions.length === 0 && <p className="text-neutral-500">No resolutions yet.</p>}
        {resolutions.map((r, i) => (
          <div key={i} className="border-b py-1 dark:border-neutral-800">
            <span className="text-green-700 dark:text-green-400">✓ {r.winner.text}</span>{" "}
            <span className="text-neutral-400">({r.winner.credibility.toFixed(2)})</span> vs{" "}
            <span className="text-red-700 line-through dark:text-red-400">{r.loser.text}</span>{" "}
            <span className="text-neutral-400">({r.loser.credibility.toFixed(2)}) — judge {r.confidence.toFixed(2)}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function Corrections({ project }: { project: string }) {
  const [pendingOnly, setPendingOnly] = useState(false);
  const { data } = useCorrections(project, pendingOnly ? "pending_confirmation" : undefined);
  const revert = useRevertCorrection(project);
  const corrections = data?.corrections ?? [];
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle>Corrections</CardTitle>
          <CardDescription>{pendingOnly ? "Pending confirmation queue" : "Feed"}</CardDescription>
        </div>
        <Button variant="outline" onClick={() => setPendingOnly((v) => !v)}>
          {pendingOnly ? "Show all" : "Pending only"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {revert.isError && <p className="text-red-600">{(revert.error as Error).message}</p>}
        {corrections.length === 0 && <p className="text-neutral-500">No corrections.</p>}
        {corrections.map((c) => (
          <div key={c.id} className="flex items-center justify-between border-b py-1 dark:border-neutral-800">
            <span>
              <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-xs dark:bg-neutral-800">{c.status}</span>{" "}
              <span className="text-neutral-400 line-through">{c.before_text ?? ""}</span> →{" "}
              {c.after_text ?? ""} <span className="text-neutral-400">({c.role_applied})</span>
            </span>
            {c.status === "applied" && (
              <Button variant="outline" onClick={() => revert.mutate(c.id)} disabled={revert.isPending}>
                Revert
              </Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
