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
import { useT } from "@/lib/i18n/context";

/** SPEC-19 — the living-knowledge view: gaps, hunts, disputed claims + resolutions, and the
 * Learning-Layer corrections feed with the pending queue + revert. Read-only except the two
 * actions the gate requires (promote a gap, revert a correction); the server enforces authz. */
export default function KnowledgePage() {
  const router = useRouter();
  const t = useT();
  const { data: me, isError } = useMe();
  const [project, setProject] = useState("");

  useEffect(() => {
    if (isError) router.replace("/login");
  }, [isError, router]);
  useEffect(() => {
    if (me && !project && me.memberships[0]) setProject(me.memberships[0].project);
  }, [me, project]);

  if (!me) return <main className="p-6 text-sm text-text-secondary">{t("common.loading")}</main>;

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t("knowledge.title")}</h1>
        <select
          aria-label={t("common.project")}
          className="h-9 rounded-[var(--radius-control)] border border-border-strong bg-surface px-2 text-sm text-text-primary"
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
        <p className="text-sm text-text-secondary">{t("common.selectProject")}</p>
      )}
    </main>
  );
}

function Metrics({ project }: { project: string }) {
  const { data } = useCorrectionMetrics(project);
  const t = useT();
  if (!data) return null;
  const cards: [string, string][] = [
    [t("knowledge.metricCorrections"), String(data.total)],
    [t("knowledge.metricApplied"), String(data.applied)],
    [t("knowledge.metricRoutedHunt"), String(data.routed_hunt)],
    [t("knowledge.metricRejected"), String(data.rejected)],
    [t("knowledge.metricRevertRate"), `${Math.round(data.revert_rate * 100)}%`],
    [t("knowledge.metricCorrectionWars"), String(data.correction_wars)],
    [t("knowledge.metricOwnershipCoverage"), `${Math.round(data.ownership_coverage * 100)}%`],
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
  const t = useT();
  const [agents, setAgents] = useState(false);
  const { data } = useGaps(project, agents);
  const promote = usePromoteGap(project);
  const gaps = data?.gaps ?? [];
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle>{t("knowledge.gapsTitle")}</CardTitle>
          <CardDescription>{agents ? t("knowledge.gapsAgentDesc") : t("knowledge.gapsHumanDesc")}</CardDescription>
        </div>
        <Button variant="outline" onClick={() => setAgents((v) => !v)}>
          {agents ? t("knowledge.showHumanGaps") : t("knowledge.showAgentGaps")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {gaps.length === 0 && <p className="text-text-secondary">{t("knowledge.noGaps")}</p>}
        {gaps.map((g) => (
          <div key={g.id} className="flex items-center justify-between border-b border-border py-1">
            <span>
              <span className="font-mono text-xs text-text-secondary">×{g.count}</span>{" "}
              {g.query_text ?? t("knowledge.queryTextHidden")} <span className="text-text-secondary">{g.topics.join(", ")}</span>
            </span>
            {agents && (
              <Button variant="outline" onClick={() => promote.mutate(g.id)} disabled={promote.isPending}>
                {t("knowledge.promoteToHunt")}
              </Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function Hunts({ project }: { project: string }) {
  const t = useT();
  const { data } = useHunts(project);
  const hunts = data?.hunts ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("knowledge.huntsTitle")}</CardTitle>
        <CardDescription>{t("knowledge.huntsDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        {hunts.length === 0 && <p className="text-text-secondary">{t("knowledge.noHunts")}</p>}
        {hunts.map((h) => (
          <div key={h.id} className="flex items-center justify-between border-b border-border py-1">
            <span>
              <span className="rounded bg-surface-subtle px-1.5 py-0.5 font-mono text-xs">{h.state}</span>{" "}
              <span className="text-text-secondary">{h.type}</span> {h.question ?? ""}
            </span>
            <span className="text-xs text-text-secondary">{h.retries > 0 ? t("knowledge.retries", { n: h.retries }) : ""}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function Disputed({ project }: { project: string }) {
  const t = useT();
  const { data } = useDisputed(project);
  const claims = data?.claims ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("knowledge.disputedTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        {claims.length === 0 && <p className="text-text-secondary">{t("knowledge.nothingDisputed")}</p>}
        {claims.map((c) => (
          <div key={c.id} className="border-b border-border py-1">
            {c.text} <span className="text-text-secondary">{t("knowledge.cred", { value: c.credibility.toFixed(2) })}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function Resolutions({ project }: { project: string }) {
  const t = useT();
  const { data } = useResolutions(project);
  const resolutions = data?.resolutions ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("knowledge.resolutionsTitle")}</CardTitle>
        <CardDescription>{t("knowledge.resolutionsDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {resolutions.length === 0 && <p className="text-text-secondary">{t("knowledge.noResolutions")}</p>}
        {resolutions.map((r, i) => (
          <div key={i} className="border-b border-border py-1">
            <span className="text-success">✓ {r.winner.text}</span>{" "}
            <span className="text-text-secondary">({r.winner.credibility.toFixed(2)})</span> {t("knowledge.vs")}{" "}
            <span className="text-danger line-through">{r.loser.text}</span>{" "}
            <span className="text-text-secondary">({r.loser.credibility.toFixed(2)}) — {t("knowledge.judge")} {r.confidence.toFixed(2)}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function Corrections({ project }: { project: string }) {
  const t = useT();
  const [pendingOnly, setPendingOnly] = useState(false);
  const { data } = useCorrections(project, pendingOnly ? "pending_confirmation" : undefined);
  const revert = useRevertCorrection(project);
  const corrections = data?.corrections ?? [];
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle>{t("knowledge.correctionsTitle")}</CardTitle>
          <CardDescription>{pendingOnly ? t("knowledge.pendingQueueDesc") : t("knowledge.feedDesc")}</CardDescription>
        </div>
        <Button variant="outline" onClick={() => setPendingOnly((v) => !v)}>
          {pendingOnly ? t("knowledge.showAll") : t("knowledge.pendingOnly")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {revert.isError && <p className="text-danger">{(revert.error as Error).message}</p>}
        {corrections.length === 0 && <p className="text-text-secondary">{t("knowledge.noCorrections")}</p>}
        {corrections.map((c) => (
          <div key={c.id} className="flex items-center justify-between border-b border-border py-1">
            <span>
              <span className="rounded bg-surface-subtle px-1.5 py-0.5 font-mono text-xs">{c.status}</span>{" "}
              <span className="text-text-secondary line-through">{c.before_text ?? ""}</span> →{" "}
              {c.after_text ?? ""} <span className="text-text-secondary">({c.role_applied})</span>
            </span>
            {c.status === "applied" && (
              <Button variant="outline" onClick={() => revert.mutate(c.id)} disabled={revert.isPending}>
                {t("knowledge.revert")}
              </Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
