import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "./client";
import { networkUiError, uiErrorFromResponse } from "./ui-error";
import type {
  Activity,
  AuditFilters,
  AuditRow,
  Correction,
  CorrectionMetrics,
  CreatedPat,
  DisputedClaim,
  Gap,
  Health,
  Hunt,
  IngestRun,
  Me,
  Neighborhood,
  PatList,
  PendingDoc,
  ProductMetrics,
  RecallRow,
  Resolution,
  ReviewQueue,
  UsageRow,
} from "./types";

/** The authenticated user + their memberships (drives the project selector + role gating). */
export function useMe() {
  return useQuery({
    queryKey: ["me"],
    retry: false,
    queryFn: async (): Promise<Me> => {
      try {
        const { data, error, response } = await api.GET("/api/v1/me");
        if (error) throw uiErrorFromResponse(response, error);
        return data;
      } catch (error) {
        if (error && typeof error === "object" && "kind" in error) throw error;
        throw networkUiError();
      }
    },
  });
}

/** The user's own PATs ("My connections"). */
export function usePats() {
  return useQuery({
    queryKey: ["me", "pats"],
    queryFn: async (): Promise<PatList> => {
      const { data, error } = await api.GET("/api/v1/me/pats");
      if (error) throw new Error("failed to load connections");
      return data as unknown as PatList;
    },
  });
}

export function useCreatePat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { project: string; name?: string }): Promise<CreatedPat> => {
      const { data, error } = await api.POST("/api/v1/me/pats", { body: input });
      if (error) throw new Error("failed to create PAT");
      return data as unknown as CreatedPat;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me", "pats"] }),
  });
}

export function useRevokePat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patId: string) => {
      const { error } = await api.DELETE("/api/v1/me/pats/{pat_id}", {
        params: { path: { pat_id: patId } },
      });
      if (error) throw new Error("failed to revoke PAT");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me", "pats"] }),
  });
}


const REFRESH_MS = 5000; // FR-13.2 auto-refresh (TanStack Query polling; no websockets)

/** Activity dashboard aggregates for a project (auto-refreshing). */
export function useActivity(project: string) {
  return useQuery({
    queryKey: ["obs", "activity", project],
    enabled: !!project,
    refetchInterval: REFRESH_MS,
    queryFn: async (): Promise<Activity> => {
      const { data, error } = await api.GET("/api/v1/admin/observability/activity", {
        params: { query: { project } },
      });
      if (error) throw new Error("failed to load activity");
      return data as unknown as Activity;
    },
  });
}

/** Live recall stream, filterable by principal + denial. */
export function useRecalls(project: string, filters: { principal_type?: string; denied?: boolean }) {
  return useQuery({
    queryKey: ["obs", "recalls", project, filters],
    enabled: !!project,
    refetchInterval: REFRESH_MS,
    queryFn: async (): Promise<{ recalls: RecallRow[] }> => {
      const { data, error } = await api.GET("/api/v1/admin/observability/recalls", {
        params: { query: { project, ...filters } },
      });
      if (error) throw new Error("failed to load recalls");
      return data as unknown as { recalls: RecallRow[] };
    },
  });
}

/** Service health widget. */
export function useHealth(project: string) {
  return useQuery({
    queryKey: ["obs", "health", project],
    enabled: !!project,
    refetchInterval: REFRESH_MS,
    queryFn: async (): Promise<Health> => {
      const { data, error } = await api.GET("/api/v1/admin/observability/health", {
        params: { query: { project } },
      });
      if (error) throw new Error("failed to load health");
      return data as unknown as Health;
    },
  });
}

/** Ingest runs + extraction errors. */
export function useIngest(project: string) {
  return useQuery({
    queryKey: ["obs", "ingest", project],
    enabled: !!project,
    refetchInterval: REFRESH_MS,
    queryFn: async (): Promise<{ runs: IngestRun[]; errors: unknown[] }> => {
      const { data, error } = await api.GET("/api/v1/admin/observability/ingest", {
        params: { query: { project } },
      });
      if (error) throw new Error("failed to load ingest");
      return data as unknown as { runs: IngestRun[]; errors: unknown[] };
    },
  });
}

/** The D13 approval queue (pending docs + preview + proposed tags). */
export function usePendingDocs(project: string) {
  return useQuery({
    queryKey: ["obs", "pending", project],
    enabled: !!project,
    refetchInterval: REFRESH_MS,
    queryFn: async (): Promise<{ documents: PendingDoc[] }> => {
      const { data, error } = await api.GET("/api/v1/admin/documents/pending/preview", {
        params: { query: { project } },
      });
      if (error) throw new Error("failed to load pending queue");
      return data as unknown as { documents: PendingDoc[] };
    },
  });
}

export function useApproveDoc(project: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { documentId: string; tags: string[] }) => {
      const { error } = await api.POST("/api/v1/admin/documents/{document_id}/approve", {
        params: { path: { document_id: input.documentId }, query: { project } },
        body: { tags: input.tags },
      });
      if (error) throw new Error("failed to approve");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["obs"] }),
  });
}

export function useRejectDoc(project: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { documentId: string; reason: string }) => {
      const { error } = await api.POST("/api/v1/admin/documents/{document_id}/reject", {
        params: { path: { document_id: input.documentId }, query: { project } },
        body: { reason: input.reason },
      });
      if (error) throw new Error("failed to reject");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["obs"] }),
  });
}


// --- SPEC-19 living knowledge ---------------------------------------------------------------

const LIVE_MS = 5000; // FR-13.5 live view (same polling pattern as the observability dashboard)

/** Gaps for a project. `agents` switches to the separate agent-gap view (FR-14.6). */
export function useGaps(project: string, agents: boolean) {
  return useQuery({
    queryKey: ["kb", "gaps", project, agents],
    enabled: !!project,
    refetchInterval: LIVE_MS,
    queryFn: async (): Promise<{ gaps: Gap[] }> => {
      const { data, error } = await api.GET("/api/v1/admin/gaps", {
        params: { query: { project, audience: agents ? "agent" : "human" } },
      });
      if (error) throw new Error("failed to load gaps");
      return data as unknown as { gaps: Gap[] };
    },
  });
}

/** Promote an agent gap to a hunt (FR-14.6). */
export function usePromoteGap(project: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (gapId: string) => {
      const { error } = await api.POST("/api/v1/admin/gaps/{gap_id}/promote", {
        params: { path: { gap_id: gapId }, query: { project } },
      });
      if (error) throw new Error("failed to promote gap");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["kb"] }),
  });
}

/** Hunts for a project (live — follows the FR-6.3 state machine). */
export function useHunts(project: string) {
  return useQuery({
    queryKey: ["kb", "hunts", project],
    enabled: !!project,
    refetchInterval: LIVE_MS,
    queryFn: async (): Promise<{ hunts: Hunt[] }> => {
      const { data, error } = await api.GET("/api/v1/admin/hunts", {
        params: { query: { project } },
      });
      if (error) throw new Error("failed to load hunts");
      return data as unknown as { hunts: Hunt[] };
    },
  });
}

/** Claims currently disputed (FR-13.5). */
export function useDisputed(project: string) {
  return useQuery({
    queryKey: ["kb", "disputed", project],
    enabled: !!project,
    refetchInterval: LIVE_MS,
    queryFn: async (): Promise<{ claims: DisputedClaim[] }> => {
      const { data, error } = await api.GET("/api/v1/admin/claims/disputed", {
        params: { query: { project } },
      });
      if (error) throw new Error("failed to load disputed claims");
      return data as unknown as { claims: DisputedClaim[] };
    },
  });
}

/** Resolved contradictions — who won, by what score (FR-5.3). */
export function useResolutions(project: string) {
  return useQuery({
    queryKey: ["kb", "resolutions", project],
    enabled: !!project,
    queryFn: async (): Promise<{ resolutions: Resolution[] }> => {
      const { data, error } = await api.GET("/api/v1/admin/contradictions/resolutions", {
        params: { query: { project } },
      });
      if (error) throw new Error("failed to load resolutions");
      return data as unknown as { resolutions: Resolution[] };
    },
  });
}

/** Corrections feed; `status` filters (e.g. the pending_confirmation queue). */
export function useCorrections(project: string, status?: string) {
  return useQuery({
    queryKey: ["kb", "corrections", project, status ?? "all"],
    enabled: !!project,
    refetchInterval: LIVE_MS,
    queryFn: async (): Promise<{ corrections: Correction[] }> => {
      const { data, error } = await api.GET("/api/v1/admin/corrections", {
        params: { query: { project, status_filter: status } },
      });
      if (error) throw new Error("failed to load corrections");
      return data as unknown as { corrections: Correction[] };
    },
  });
}

/** The Learning-Layer §7 metrics. */
export function useCorrectionMetrics(project: string) {
  return useQuery({
    queryKey: ["kb", "metrics", project],
    enabled: !!project,
    queryFn: async (): Promise<CorrectionMetrics> => {
      const { data, error } = await api.GET("/api/v1/admin/corrections/metrics", {
        params: { query: { project } },
      });
      if (error) throw new Error("failed to load metrics");
      return data as unknown as CorrectionMetrics;
    },
  });
}

/** Revert a correction (server enforces admin-or-tag-owner; FR-15.8). */
export function useRevertCorrection(project: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (correctionId: string) => {
      const { error } = await api.POST("/api/v1/admin/corrections/{correction_id}/revert", {
        params: { path: { correction_id: correctionId }, query: { project } },
      });
      if (error) throw new Error("revert failed (are you an admin or the tag owner?)");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["kb"] }),
  });
}


// --- SPEC-21 unified needs_review queue -----------------------------------------------------

/** The unified needs_review queue (4 sources); optionally filtered by source. */
export function useReviewQueue(project: string, source?: string) {
  return useQuery({
    queryKey: ["review", project, source ?? "all"],
    enabled: !!project,
    refetchInterval: LIVE_MS,
    queryFn: async (): Promise<ReviewQueue> => {
      const { data, error } = await api.GET("/api/v1/admin/review-queue", {
        params: { query: { project, source } },
      });
      if (error) throw new Error("failed to load the review queue");
      return data as unknown as ReviewQueue;
    },
  });
}

/** Resolve a needs_review chunk (approve → recallable, or reject). */
export function useResolveChunk(project: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { chunkId: string; approve: boolean; tags?: string[] }) => {
      const { error } = await api.POST("/api/v1/admin/review-queue/chunks/{chunk_id}/resolve", {
        params: { path: { chunk_id: input.chunkId }, query: { project, approve: input.approve } },
        body: { tags: input.tags ?? null },
      });
      if (error) throw new Error("failed to resolve chunk");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["review"] }),
  });
}

/** Resolve an entity-merge proposal (approve → merge applied, or reject). */
export function useResolveMerge(project: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { proposalId: string; approve: boolean }) => {
      const { error } = await api.POST("/api/v1/admin/review-queue/merges/{proposal_id}/resolve", {
        params: { path: { proposal_id: input.proposalId }, query: { project, approve: input.approve } },
      });
      if (error) throw new Error("failed to resolve merge");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["review"] }),
  });
}


// --- SPEC-26 console release ----------------------------------------------------------------

/** Per-capability/day token usage (SPEC-26 FR-13.7). Same source as `brain usage`. */
export function useUsage(project: string, days: number) {
  return useQuery({
    queryKey: ["usage", project, days],
    enabled: !!project,
    queryFn: async (): Promise<{ usage: UsageRow[] }> => {
      const { data, error } = await api.GET("/api/v1/admin/usage", {
        params: { query: { project, days } },
      });
      if (error) throw new Error("failed to load usage");
      return data as unknown as { usage: UsageRow[] };
    },
  });
}

/** Filterable audit log (SPEC-26 FR-13.7). */
export function useAudit(project: string, filters: AuditFilters, limit = 200) {
  return useQuery({
    queryKey: ["audit", project, filters, limit],
    enabled: !!project,
    queryFn: async (): Promise<{ audit: AuditRow[] }> => {
      const { data, error } = await api.GET("/api/v1/admin/audit", {
        params: { query: { project, limit, ...filters } },
      });
      if (error) throw new Error("failed to load audit log");
      return data as unknown as { audit: AuditRow[] };
    },
  });
}

/** The four PRD §8 metric families (SPEC-26 E11.3), straight from the API. */
export function useProductMetrics(project: string, windowDays = 30) {
  return useQuery({
    queryKey: ["metrics", project, windowDays],
    enabled: !!project,
    queryFn: async (): Promise<ProductMetrics> => {
      const { data, error } = await api.GET("/api/v1/admin/metrics/product", {
        params: { query: { project, window_days: windowDays } },
      });
      if (error) throw new Error("failed to load product metrics");
      return data as unknown as ProductMetrics;
    },
  });
}

/** A bounded, paginated entity neighborhood (SPEC-26 FR-13.8). Null center ⇒ not found/invisible. */
export function useEntityGraph(project: string, name: string, offset: number, limit = 25) {
  return useQuery({
    queryKey: ["graph", project, name, offset, limit],
    enabled: !!project && !!name,
    retry: false,
    queryFn: async (): Promise<Neighborhood | null> => {
      const { data, error } = await api.GET("/api/v1/admin/graph/entity", {
        params: { query: { project, name, offset, limit } },
      });
      if (error) return null; // 404 ≡ absent/invisible (FR-4.3)
      return data as unknown as Neighborhood;
    },
  });
}
