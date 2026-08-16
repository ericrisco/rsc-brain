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

interface ProjectScopeValue {
  project: string;
  membership?: Membership;
  capabilities: readonly string[];
  isSwitching: boolean;
  switchProject: (project: string) => Promise<void>;
}

const ProjectScopeContext = createContext<ProjectScopeValue | null>(null);

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

export function ProjectScopeProvider({ session, children }: { session: Me; children: ReactNode }) {
  const queryClient = useQueryClient();
  const t = useT();
  const firstProject = session.memberships[0]?.project ?? "";
  const [project, setProject] = useState(firstProject);
  const [isSwitching, setIsSwitching] = useState(false);
  const transition = useRef(0);

  const isAllowedProject = useCallback(
    (candidate: string) =>
      session.memberships.some((membership) => membership.project === candidate) ||
      (candidate === "" &&
        (session.platform_capabilities.length > 0 || session.memberships.length === 0)),
    [session.memberships, session.platform_capabilities.length],
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
      window.localStorage.setItem(storageKey(session.identity.id), nextProject);
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
    const preferred = window.localStorage.getItem(storageKey(session.identity.id));
    if (preferred && preferred !== project && isAllowedProject(preferred)) {
      void switchProject(preferred);
    }
  }, [isAllowedProject, project, session.identity.id, switchProject]);

  useEffect(() => {
    if (isAllowedProject(project)) return;
    void switchProject(firstProject);
  }, [firstProject, isAllowedProject, project, switchProject]);

  const membership = session.memberships.find((item) => item.project === project);
  const value = useMemo<ProjectScopeValue>(
    () => ({
      project,
      membership,
      capabilities: membership?.capabilities ?? [],
      isSwitching,
      switchProject,
    }),
    [isSwitching, membership, project, switchProject],
  );

  return (
    <ProjectScopeContext.Provider value={value}>
      {isSwitching ? (
        <div
          role="status"
          aria-live="polite"
          className="grid min-h-[12rem] place-items-center text-sm text-text-secondary"
        >
          {t("common.switchingProject")}
        </div>
      ) : (
        children
      )}
    </ProjectScopeContext.Provider>
  );
}

export function useProjectScope(): ProjectScopeValue {
  const value = useContext(ProjectScopeContext);
  if (!value) throw new Error("useProjectScope must be used within ProjectScopeProvider");
  return value;
}
