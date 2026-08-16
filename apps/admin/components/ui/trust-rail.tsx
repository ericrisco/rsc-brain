import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type TrustSegment = {
  id: string;
  label: string;
  status: string;
  detail: string;
  tone: "neutral" | "success" | "warning" | "danger";
  action?: ReactNode;
};

const toneStyles = {
  neutral: "border-l-border-strong",
  success: "border-l-success",
  warning: "border-l-warning",
  danger: "border-l-danger",
};

/** The one signature pattern: actionable posture, always labelled and never decorative. */
export function TrustRail({ segments, label = "Control plane posture" }: { segments: TrustSegment[]; label?: string }) {
  return (
    <section aria-label={label} className="grid border-y border-border bg-surface md:grid-cols-2 xl:grid-cols-4">
      {segments.map((segment) => (
        <article
          key={segment.id}
          className={cn(
            "border-b border-l-2 border-b-border px-4 py-4 last:border-b-0 md:odd:border-r md:odd:border-r-border xl:border-b-0 xl:border-r xl:border-r-border xl:last:border-r-0",
            toneStyles[segment.tone],
          )}
        >
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-xs font-medium uppercase tracking-[0.08em] text-text-secondary">
              {segment.label}
            </h2>
            <span className="font-mono text-xs text-text-primary">{segment.status}</span>
          </div>
          <p className="mt-2 text-sm text-text-secondary">{segment.detail}</p>
          {segment.action ? <div className="mt-3">{segment.action}</div> : null}
        </article>
      ))}
    </section>
  );
}
