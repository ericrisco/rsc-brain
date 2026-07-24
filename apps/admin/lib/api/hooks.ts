import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "./client";
import type { CreatedPat, Me, PatList } from "./types";

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
