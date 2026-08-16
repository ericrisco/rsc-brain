import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

const tones = {
  info: "border-info/40 bg-info-muted text-text-primary",
  success: "border-success/40 bg-success-muted text-text-primary",
  warning: "border-warning/40 bg-warning-muted text-text-primary",
  danger: "border-danger/40 bg-danger-muted text-text-primary",
} as const;

export function Banner({
  title,
  children,
  tone = "info",
  actions,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  title: string;
  tone?: keyof typeof tones;
  actions?: ReactNode;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "grid gap-3 rounded-[var(--radius-panel)] border p-4 sm:grid-cols-[1fr_auto] sm:items-center",
        tones[tone],
        className,
      )}
      {...props}
    >
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <div className="mt-1 text-sm text-text-secondary">{children}</div>
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
