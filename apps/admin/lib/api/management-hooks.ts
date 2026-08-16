import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "./client";
import type {
  CredentialEnvelope,
  CredentialList,
  DisableResult,
  HuntCommand,
  InviteResult,
  MembershipTransition,
  MembershipList,
  PasswordResetResult,
  ProjectDeleteResult,
  ProjectEnvelope,
  ProjectImpact,
  ProjectInventory,
  ProjectTransition,
  SkillCommand,
  SkillCreateResult,
  SkillList,
  TopicEnvelope,
  TopicList,
  TopicTransition,
  UserPage,
} from "./types";
import { uiErrorFromResponse } from "./ui-error";

function commandKey() {
  return globalThis.crypto?.randomUUID?.() ?? `console-${Date.now()}-${Math.random()}`;
}

export function useProjects() {
  return useQuery({
    queryKey: ["management", "projects"],
    queryFn: async (): Promise<ProjectInventory> => {
      const { data, error, response } = await api.GET("/api/v1/admin/projects");
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
  });
}

export function useCreateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { slug: string; name: string; settings: Record<string, unknown> }): Promise<ProjectEnvelope> => {
      const { data, error, response } = await api.POST("/api/v1/admin/projects", {
        headers: { "Idempotency-Key": commandKey() },
        body: input,
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["management", "projects"] }),
  });
}

export function useUpdateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { slug: string; expectedVersion: number; name?: string; settings?: Record<string, unknown> }): Promise<ProjectTransition> => {
      const { data, error, response } = await api.PATCH("/api/v1/admin/projects/{slug}", {
        params: { path: { slug: input.slug } },
        headers: { "Idempotency-Key": commandKey() },
        body: { expected_version: input.expectedVersion, name: input.name, settings: input.settings },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["management", "projects"] }),
  });
}

export function useProjectDeleteImpact(slug: string | null) {
  return useQuery({
    queryKey: ["management", "projects", slug, "delete-impact"],
    enabled: !!slug,
    queryFn: async (): Promise<ProjectImpact> => {
      const { data, error, response } = await api.GET("/api/v1/admin/projects/{slug}/delete-impact", {
        params: { path: { slug: slug! } },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
  });
}

export function useDeleteProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { slug: string; expectedVersion: number; confirm: string }): Promise<ProjectDeleteResult> => {
      const { data, error, response } = await api.DELETE("/api/v1/admin/projects/{slug}", {
        params: { path: { slug: input.slug }, query: { expected_version: input.expectedVersion, confirm: input.confirm } },
        headers: { "Idempotency-Key": commandKey() },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["management", "projects"] }),
  });
}

export function useUsers(project: string, cursor?: string) {
  return useQuery({
    queryKey: ["management", "users", project, cursor],
    enabled: !!project,
    queryFn: async (): Promise<UserPage> => {
      const { data, error, response } = await api.GET("/api/v1/admin/users", {
        params: { query: { project, limit: 50, cursor } },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
  });
}

export function useMemberships(project: string) {
  return useQuery({
    queryKey: ["management", "memberships", project],
    enabled: !!project,
    queryFn: async (): Promise<MembershipList> => {
      const { data, error, response } = await api.GET("/api/v1/admin/memberships", {
        params: { query: { project } },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
  });
}

export function useInviteUser(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { email: string; projectRole: string; platformRole: string; allowedTopics: string[]; canCurate: boolean }): Promise<InviteResult> => {
      const { data, error, response } = await api.POST("/api/v1/admin/users/invite", {
        params: { query: { project } },
        headers: { "Idempotency-Key": commandKey() },
        body: {
          email: input.email,
          project_role: input.projectRole,
          platform_role: input.platformRole,
          allowed_topics: input.allowedTopics,
          can_curate: input.canCurate,
        },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["management", "users", project] }),
  });
}

export function useDisableUser(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { userId: string; expectedStatus: string }): Promise<DisableResult> => {
      const { data, error, response } = await api.POST("/api/v1/admin/users/{user_id}/disable", {
        params: { path: { user_id: input.userId }, query: { project } },
        headers: { "Idempotency-Key": commandKey() },
        body: { expected_status: input.expectedStatus, impact_acknowledged: true },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["management", "users", project] }),
  });
}

export function useRequestPasswordReset(project: string) {
  return useMutation({
    mutationFn: async (userId: string): Promise<PasswordResetResult> => {
      const { data, error, response } = await api.POST("/api/v1/admin/users/{user_id}/password-reset", {
        params: { path: { user_id: userId }, query: { project } },
        headers: { "Idempotency-Key": commandKey() },
        body: { impact_acknowledged: true },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
  });
}

export function useUserCredentials(project: string, userId: string | null) {
  return useQuery({
    queryKey: ["management", "credentials", project, userId],
    enabled: !!project && !!userId,
    queryFn: async (): Promise<CredentialList> => {
      const { data, error, response } = await api.GET("/api/v1/admin/users/{user_id}/credentials", {
        params: { path: { user_id: userId! }, query: { project } },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
  });
}

export function useCreateUserCredential(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { userId: string; name?: string; kind?: string }): Promise<CredentialEnvelope> => {
      const { data, error, response } = await api.POST("/api/v1/admin/users/{user_id}/credentials", {
        params: { path: { user_id: input.userId }, query: { project } },
        headers: { "Idempotency-Key": commandKey() },
        body: { name: input.name, kind: input.kind ?? "pat" },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["management", "credentials", project] }),
  });
}

export function useRotateUserCredential(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { credentialId: string; expectedVersion: number }): Promise<CredentialEnvelope> => {
      const { data, error, response } = await api.POST("/api/v1/admin/credentials/{credential_id}/rotate", {
        params: { path: { credential_id: input.credentialId }, query: { project } },
        headers: { "Idempotency-Key": commandKey() },
        body: { expected_version: input.expectedVersion },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["management", "credentials", project] }),
  });
}

export function useRevokeUserCredential(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { credentialId: string; expectedVersion: number }): Promise<CredentialEnvelope> => {
      const { data, error, response } = await api.DELETE("/api/v1/admin/credentials/{credential_id}", {
        params: { path: { credential_id: input.credentialId }, query: { project, expected_version: input.expectedVersion } },
        headers: { "Idempotency-Key": commandKey() },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["management", "credentials", project] }),
  });
}

export function useUpdateMembership(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { userId: string; expectedVersion: number; role?: string; allowedTopics?: string[]; canCurate?: boolean }): Promise<MembershipTransition> => {
      const { data, error, response } = await api.PATCH("/api/v1/admin/memberships/{user_id}", {
        params: { path: { user_id: input.userId }, query: { project } },
        headers: { "Idempotency-Key": commandKey() },
        body: { expected_version: input.expectedVersion, role: input.role, allowed_topics: input.allowedTopics, can_curate: input.canCurate },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["management", "users", project] }),
        client.invalidateQueries({ queryKey: ["management", "memberships", project] }),
      ]);
    },
  });
}

export function useTopics(project: string) {
  return useQuery({
    queryKey: ["management", "topics", project],
    enabled: !!project,
    queryFn: async (): Promise<TopicList> => {
      const { data, error, response } = await api.GET("/api/v1/admin/topics", { params: { query: { project } } });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
  });
}

export function useCreateTopic(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { slug: string; name: string; sensitivity: number; hardWindowDays: number | null }): Promise<TopicEnvelope> => {
      const { data, error, response } = await api.POST("/api/v1/admin/topics", {
        params: { query: { project } },
        headers: { "Idempotency-Key": commandKey() },
        body: { slug: input.slug, name: input.name, sensitivity: input.sensitivity, hard_window_days: input.hardWindowDays },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["management", "topics", project] }),
  });
}

export function useUpdateTopic(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { slug: string; expectedVersion: number; name?: string; sensitivity?: number; hardWindowDays?: number | null }): Promise<TopicTransition> => {
      const { data, error, response } = await api.PATCH("/api/v1/admin/topics/{slug}", {
        params: { path: { slug: input.slug }, query: { project } },
        headers: { "Idempotency-Key": commandKey() },
        body: { expected_version: input.expectedVersion, name: input.name, sensitivity: input.sensitivity, hard_window_days: input.hardWindowDays },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["management", "topics", project] }),
  });
}

export function useGrantTopic(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { slug: string; userId: string }) => {
      const { data, error, response } = await api.POST("/api/v1/admin/topics/{slug}/grants", {
        params: { path: { slug: input.slug }, query: { project } },
        headers: { "Idempotency-Key": commandKey() },
        body: { user_id: input.userId },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["management"] }),
  });
}

export function useRevokeTopic(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { slug: string; userId: string }) => {
      const { data, error, response } = await api.DELETE("/api/v1/admin/topics/{slug}/grants/{user_id}", {
        params: { path: { slug: input.slug, user_id: input.userId }, query: { project } },
        headers: { "Idempotency-Key": commandKey() },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["management"] }),
  });
}

export function useAskHunt(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { question: string; topics: string[] }): Promise<HuntCommand> => {
      const { data, error, response } = await api.POST("/api/v1/admin/hunts/ask", {
        params: { query: { project } },
        headers: { "Idempotency-Key": commandKey() },
        body: input,
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["kb", "hunts", project] }),
  });
}

export function useSkills(project: string, state?: string) {
  return useQuery({
    queryKey: ["management", "skills", project, state],
    enabled: !!project,
    queryFn: async (): Promise<SkillList> => {
      const { data, error, response } = await api.GET("/api/v1/admin/skills", {
        params: { query: { project, state } },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
  });
}

export function useCreateSkill(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (markdown: string): Promise<SkillCreateResult> => {
      const { data, error, response } = await api.POST("/api/v1/admin/skills", {
        params: { query: { project } },
        body: { markdown },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["management", "skills", project] }),
  });
}

export function useValidateSkill(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { slug: string; expectedVersion: number }): Promise<SkillCommand> => {
      const { data, error, response } = await api.POST("/api/v1/admin/skills/{slug}/validate", {
        params: { path: { slug: input.slug }, query: { project } },
        headers: { "Idempotency-Key": commandKey() },
        body: { expected_version: input.expectedVersion },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["management", "skills", project] }),
  });
}

export function useArchiveSkill(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { slug: string; expectedVersion: number }): Promise<SkillCommand> => {
      const { data, error, response } = await api.POST("/api/v1/admin/skills/{slug}/archive", {
        params: { path: { slug: input.slug }, query: { project } },
        headers: { "Idempotency-Key": commandKey() },
        body: { expected_version: input.expectedVersion },
      });
      if (error) throw uiErrorFromResponse(response, error);
      return data;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["management", "skills", project] }),
  });
}
