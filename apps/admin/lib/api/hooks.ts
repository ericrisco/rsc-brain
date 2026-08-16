import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "./client";
import { networkUiError, uiErrorFromResponse } from "./ui-error";
import type {
  Activity,
  Audit,
  AuditFilters,
  CorrectionList,
  CorrectionMetrics,
  CorrectionRevertResult,
  CreatedPat,
  ChunkReviewResolution,
  DisputedClaimList,
  GapList,
  Health,
  HuntList,
  Ingest,
  Me,
  MergeReviewResolution,
  Neighborhood,
  PatList,
  PendingDocList,
  ProductMetrics,
  RecallPage,
  RevokedPat,
  ResolutionList,
  ReviewQueue,
  Usage,
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
      const { data, error, response } = await api.GET("/api/v1/me/pats");
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
  });
}

export function useCreatePat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { project: string; name?: string }): Promise<CreatedPat> => {
      const { data, error, response } = await api.POST("/api/v1/me/pats", { body: input });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me", "pats"] }),
  });
}

export function useRevokePat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patId: string): Promise<RevokedPat> => {
      const { data, error, response } = await api.DELETE("/api/v1/me/pats/{pat_id}", {
        params: { path: { pat_id: patId } },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me", "pats"] }),
  });
}


const REFRESH_MS = 5000; // FR-13.2 auto-refresh (TanStack Query polling; no websockets)
type PollingOptions = { paused?: boolean; enabled?: boolean };

/** Activity dashboard aggregates for a project (auto-refreshing). */
export function useActivity(
  project: string,
  { paused = false, enabled = true }: PollingOptions = {},
) {
  return useQuery({
    queryKey: ["obs", "activity", project],
    enabled: !!project && enabled,
    refetchInterval: paused ? false : REFRESH_MS,
    queryFn: async (): Promise<Activity> => {
      const { data, error, response } = await api.GET("/api/v1/admin/observability/activity", {
        params: { query: { project } },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
  });
}

/** Live recall stream, filterable by principal + denial. */
export function useRecalls(
  project: string,
  filters: { principal_type?: string; denied?: boolean },
  { paused = false, enabled = true }: PollingOptions = {},
) {
  return useQuery({
    queryKey: ["obs", "recalls", project, filters],
    enabled: !!project && enabled,
    refetchInterval: paused ? false : REFRESH_MS,
    queryFn: async (): Promise<RecallPage> => {
      const { data, error, response } = await api.GET("/api/v1/admin/observability/recalls", {
        params: { query: { project, ...filters } },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
  });
}

/** Service health widget. */
export function useHealth(
  project: string,
  { paused = false, enabled = true }: PollingOptions = {},
) {
  return useQuery({
    queryKey: ["obs", "health", project],
    enabled: !!project && enabled,
    refetchInterval: paused ? false : REFRESH_MS,
    queryFn: async (): Promise<Health> => {
      const { data, error, response } = await api.GET("/api/v1/admin/observability/health", {
        params: { query: { project } },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
  });
}

/** Ingest runs + extraction errors. */
export function useIngest(
  project: string,
  { paused = false, enabled = true }: PollingOptions = {},
) {
  return useQuery({
    queryKey: ["obs", "ingest", project],
    enabled: !!project && enabled,
    refetchInterval: paused ? false : REFRESH_MS,
    queryFn: async (): Promise<Ingest> => {
      const { data, error, response } = await api.GET("/api/v1/admin/observability/ingest", {
        params: { query: { project } },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
  });
}

/** The D13 approval queue (pending docs + preview + proposed tags). */
export function usePendingDocs(
  project: string,
  { paused = false, enabled = true }: PollingOptions = {},
) {
  return useQuery({
    queryKey: ["obs", "pending", project],
    enabled: !!project && enabled,
    refetchInterval: paused ? false : REFRESH_MS,
    queryFn: async (): Promise<PendingDocList> => {
      const { data, error, response } = await api.GET("/api/v1/admin/documents/pending/preview", {
        params: { query: { project } },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
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
    queryFn: async (): Promise<GapList> => {
      const { data, error, response } = await api.GET("/api/v1/admin/gaps", {
        params: { query: { project, audience: agents ? "agent" : "human" } },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
  });
}

/** Promote an agent gap to a hunt (FR-14.6). */
export function usePromoteGap(project: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (gapId: string) => {
      const { data, error, response } = await api.POST("/api/v1/admin/gaps/{gap_id}/promote", {
        params: { path: { gap_id: gapId }, query: { project } },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["kb"] }),
  });
}

/** Hunts for a project (live — follows the FR-6.3 state machine). */
export function useHunts(project: string, openOnly = false) {
  return useQuery({
    queryKey: ["kb", "hunts", project, openOnly],
    enabled: !!project,
    refetchInterval: LIVE_MS,
    queryFn: async (): Promise<HuntList> => {
      const { data, error, response } = await api.GET("/api/v1/admin/hunts", {
        params: { query: { project, open_only: openOnly } },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
  });
}

export {
  useArchiveSkill,
  useAskHunt,
  useCreateProject,
  useCreateSkill,
  useCreateTopic,
  useCreateUserCredential,
  useDeleteProject,
  useDisableUser,
  useGrantTopic,
  useInviteUser,
  useMemberships,
  useProjectDeleteImpact,
  useProjects,
  useRequestPasswordReset,
  useRevokeTopic,
  useRevokeUserCredential,
  useRotateUserCredential,
  useSkills,
  useTopics,
  useUpdateMembership,
  useUpdateProject,
  useUpdateTopic,
  useUserCredentials,
  useUsers,
  useValidateSkill,
} from "./management-hooks";

/** Claims currently disputed (FR-13.5). */
export function useDisputed(project: string) {
  return useQuery({
    queryKey: ["kb", "disputed", project],
    enabled: !!project,
    refetchInterval: LIVE_MS,
    queryFn: async (): Promise<DisputedClaimList> => {
      const { data, error, response } = await api.GET("/api/v1/admin/claims/disputed", {
        params: { query: { project } },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
  });
}

/** Resolved contradictions — who won, by what score (FR-5.3). */
export function useResolutions(project: string) {
  return useQuery({
    queryKey: ["kb", "resolutions", project],
    enabled: !!project,
    queryFn: async (): Promise<ResolutionList> => {
      const { data, error, response } = await api.GET("/api/v1/admin/contradictions/resolutions", {
        params: { query: { project } },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
  });
}

/** Corrections feed; `status` filters (e.g. the pending_confirmation queue). */
export function useCorrections(project: string, status?: string) {
  return useQuery({
    queryKey: ["kb", "corrections", project, status ?? "all"],
    enabled: !!project,
    refetchInterval: LIVE_MS,
    queryFn: async (): Promise<CorrectionList> => {
      const { data, error, response } = await api.GET("/api/v1/admin/corrections", {
        params: { query: { project, status_filter: status } },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
  });
}

/** The Learning-Layer §7 metrics. */
export function useCorrectionMetrics(project: string) {
  return useQuery({
    queryKey: ["kb", "metrics", project],
    enabled: !!project,
    queryFn: async (): Promise<CorrectionMetrics> => {
      const { data, error, response } = await api.GET("/api/v1/admin/corrections/metrics", {
        params: { query: { project } },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
  });
}

/** Revert a correction (server enforces admin-or-tag-owner; FR-15.8). */
export function useRevertCorrection(project: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (correctionId: string): Promise<CorrectionRevertResult> => {
      const { data, error, response } = await api.POST("/api/v1/admin/corrections/{correction_id}/revert", {
        params: { path: { correction_id: correctionId }, query: { project } },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
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
      const { data, error, response } = await api.GET("/api/v1/admin/review-queue", {
        params: { query: { project, source } },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
  });
}

/** Resolve a needs_review chunk (approve → recallable, or reject). */
export function useResolveChunk(project: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { chunkId: string; approve: boolean; tags?: string[] }): Promise<ChunkReviewResolution> => {
      const { data, error, response } = await api.POST("/api/v1/admin/review-queue/chunks/{chunk_id}/resolve", {
        params: { path: { chunk_id: input.chunkId }, query: { project, approve: input.approve } },
        body: { tags: input.tags ?? null },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["review"] }),
  });
}

/** Resolve an entity-merge proposal (approve → merge applied, or reject). */
export function useResolveMerge(project: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { proposalId: string; approve: boolean }): Promise<MergeReviewResolution> => {
      const { data, error, response } = await api.POST("/api/v1/admin/review-queue/merges/{proposal_id}/resolve", {
        params: { path: { proposal_id: input.proposalId }, query: { project, approve: input.approve } },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["review"] }),
  });
}


// --- SPEC-26 console release ----------------------------------------------------------------

/** Per-capability/day token usage (SPEC-26 FR-13.7). Same source as `brain usage`. */
export function useUsage(project: string, days: number, capability?: string) {
  return useQuery({
    queryKey: ["usage", project, days, capability],
    enabled: !!project,
    queryFn: async (): Promise<Usage> => {
      try {
        const { data, error, response } = await api.GET("/api/v1/admin/usage", {
          params: { query: { project, days, capability } },
        });
        if (error) throw uiErrorFromResponse(response, error);
        return data;
      } catch (error) {
        if (error && typeof error === "object" && "kind" in error) throw error;
        throw networkUiError();
      }
    },
  });
}

/** Filterable audit log (SPEC-26 FR-13.7). */
export function useAudit(project: string, filters: AuditFilters, limit = 50, offset = 0) {
  return useQuery({
    queryKey: ["audit", project, filters, limit, offset],
    enabled: !!project,
    queryFn: async (): Promise<Audit> => {
      try {
        const { data, error, response } = await api.GET("/api/v1/admin/audit", {
          params: { query: { project, limit, offset, ...filters } },
        });
        if (error) throw uiErrorFromResponse(response, error);
        return data;
      } catch (error) {
        if (error && typeof error === "object" && "kind" in error) throw error;
        throw networkUiError();
      }
    },
  });
}

/** The four PRD §8 metric families (SPEC-26 E11.3), straight from the API. */
export function useProductMetrics(project: string, windowDays = 30) {
  return useQuery({
    queryKey: ["metrics", project, windowDays],
    enabled: !!project,
    queryFn: async (): Promise<ProductMetrics> => {
      try {
        const { data, error, response } = await api.GET("/api/v1/admin/metrics/product", {
          params: { query: { project, window_days: windowDays } },
        });
        if (error) throw uiErrorFromResponse(response, error);
        return data;
      } catch (error) {
        if (error && typeof error === "object" && "kind" in error) throw error;
        throw networkUiError();
      }
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
      try {
        const { data, error, response } = await api.GET("/api/v1/admin/graph/entity", {
          params: { query: { project, name, offset, limit } },
        });
        if (response.status === 404) return null; // absent ≡ invisible (FR-4.3)
        if (error) throw uiErrorFromResponse(response, error);
        return data;
      } catch (error) {
        if (error && typeof error === "object" && "kind" in error) throw error;
        throw networkUiError();
      }
    },
  });
}
