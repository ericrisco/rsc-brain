"use client";

import { useState } from "react";

import type { Me } from "@/lib/api/types";

/**
 * Project selector for multi-membership users; `owner` additionally gets an "All projects"
 * (global) option. The selection is UI state only — the API is always the authority for what a
 * request may touch (a project outside the user's membership is rejected server-side).
 */
export function ProjectSelector({ me }: { me: Me }) {
  const [selected, setSelected] = useState(me.memberships[0]?.project ?? "");

  if (me.memberships.length === 0 && !me.is_owner) {
    return <span className="text-sm text-neutral-500">No projects</span>;
  }

  return (
    <select
      aria-label="Active project"
      className="h-9 rounded-md border border-neutral-300 bg-transparent px-2 text-sm dark:border-neutral-700"
      value={selected}
      onChange={(event) => setSelected(event.target.value)}
    >
      {me.is_owner ? <option value="">All projects</option> : null}
      {me.memberships.map((membership) => (
        <option key={membership.project} value={membership.project}>
          {membership.project} ({membership.role})
        </option>
      ))}
    </select>
  );
}
