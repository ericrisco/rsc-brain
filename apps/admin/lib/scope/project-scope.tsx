"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { Me, Membership } from "@/lib/api/types";
import { useT } from "@/lib/i18n/context";

export interface ProjectScopeState {
  project: string;
  scope: string;
  revision: number;
  status: "ready" | "switching";
  membership?: Membership;
  capabilities: readonly string[];
  isSwitching: boolean;
  queryKey: (resource: string, filters?: unknown) => readonly unknown[];
  switchProject: (project: string) => Promise<void>;
}

const ProjectScopeContext = createContext<ProjectScopeState | null>(null);

function storageKey(userId: string): string {
  return `rsc-brain.project.${userId}`;
}

function containsProject(value: unknown, project: string): boolean {
  if (value === project) return true;
  if (Array.isArray(value)) return value.some((item) => containsProject(item, project));
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => containsProject(item, project));
  }
  return false;
}

function queryBelongsToProject(queryKey: readonly unknown[], project: string): boolean {
  return project.length > 0 && queryKey.some((part) => containsProject(part, project));
}

export function ProjectScopeProvider({
  session,
  allowGlobal = false,
  children,
}: {
  session: Me;
  allowGlobal?: boolean;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const firstProject = session.memberships[0]?.project ?? "";
  const [project, setProject] = useState(allowGlobal ? "" : firstProject);
  const [revision, setRevision] = useState(0);
  const [isSwitching, setIsSwitching] = useState(false);
  const transition = useRef(0);

  const isAllowedProject = useCallback(
    (candidate: string) =>
      session.memberships.some((membership) => membership.project === candidate) ||
      (candidate === "" && (allowGlobal || session.memberships.length === 0)),
    [allowGlobal, session.memberships],
  );

  const switchProject = useCallback(
    async (nextProject: string) => {
      if (nextProject === project || !isAllowedProject(nextProject)) return;
      const currentTransition = ++transition.current;
      const previousProject = project;
      setIsSwitching(true);

      if (previousProject) {
        const previousPredicate = (query: { queryKey: readonly unknown[] }) =>
          queryBelongsToProject(query.queryKey, previousProject);
        await queryClient.cancelQueries({ predicate: previousPredicate });
        if (currentTransition !== transition.current) return;
        queryClient.removeQueries({ predicate: previousPredicate });
      }

      setProject(nextProject);
      setRevision((current) => current + 1);
      if (nextProject) window.localStorage.setItem(storageKey(session.identity.id), nextProject);
      if (nextProject) {
        await queryClient.invalidateQueries({
          predicate: (query) => queryBelongsToProject(query.queryKey, nextProject),
        });
      }
      if (currentTransition === transition.current) setIsSwitching(false);
    },
    [isAllowedProject, project, queryClient, session.identity.id],
  );

  useEffect(() => {
    if (allowGlobal) {
      if (project !== "") void switchProject("");
      return;
    }
    const preferred = window.localStorage.getItem(storageKey(session.identity.id));
    if (preferred && preferred !== project && isAllowedProject(preferred)) {
      void switchProject(preferred);
    }
  }, [allowGlobal, isAllowedProject, project, session.identity.id, switchProject]);

  useEffect(() => {
    if (isAllowedProject(project)) return;
    void switchProject(firstProject);
  }, [firstProject, isAllowedProject, project, switchProject]);

  const membership = session.memberships.find((item) => item.project === project);
  const scope = project || "platform";
  const queryKey = useCallback(
    (resource: string, filters?: unknown) =>
      [
        "scope",
        session.identity.id,
        scope,
        revision,
        resource,
        ...(filters === undefined ? [] : [filters]),
      ] as const,
    [revision, scope, session.identity.id],
  );
  const value = useMemo<ProjectScopeState>(
    () => ({
      project,
      scope,
      revision,
      status: isSwitching ? "switching" : "ready",
      membership,
      capabilities: membership?.capabilities ?? [],
      isSwitching,
      queryKey,
      switchProject,
    }),
    [isSwitching, membership, project, queryKey, revision, scope, switchProject],
  );

  return (
    <ProjectScopeContext.Provider value={value}>{children}</ProjectScopeContext.Provider>
  );
}

export function ProjectScopeContent({ children }: { children: ReactNode }) {
  const { isSwitching } = useProjectScope();
  const t = useT();
  if (isSwitching) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="grid min-h-[12rem] place-items-center text-sm text-text-secondary"
      >
        {t("common.switchingProject")}
      </div>
    );
  }
  return children;
}

export function useProjectScope(): ProjectScopeState {
  const value = useContext(ProjectScopeContext);
  if (!value) throw new Error("useProjectScope must be used within ProjectScopeProvider");
  return value;
}
