import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "./client";
import type {
  Activity,
  Correction,
  CorrectionMetrics,
  CreatedPat,
  DisputedClaim,
  Gap,
  Health,
  Hunt,
  IngestRun,
  Me,
  PatList,
  PendingDoc,
  RecallRow,
  Resolution,
} from "./types";

/** The authenticated user + their memberships (drives the project selector + role gating). */
export function useMe() {
  return useQuery({
    queryKey: ["me"],
    retry: false,
    queryFn: async (): Promise<Me> => {
      const { data, error } = await api.GET("/api/v1/me");
      if (error) throw new Error("unauthenticated");
      return data as unknown as Me;
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
