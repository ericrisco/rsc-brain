import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

export function FilterBar({
  label = "Filters",
  actions,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { label?: string; actions?: ReactNode }) {
  return (
    <section
      aria-label={label}
      className={cn(
        "flex flex-col gap-3 border-y border-border bg-surface-subtle/45 px-3 py-3 sm:flex-row sm:items-end sm:justify-between",
        className,
      )}
      {...props}
    >
      <div className="flex flex-1 flex-wrap items-end gap-3">{children}</div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </section>
  );
}
