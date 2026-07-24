import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "./client";
import type {
  Activity,
  CreatedPat,
  Health,
  IngestRun,
  Me,
  PatList,
  PendingDoc,
  RecallRow,
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
