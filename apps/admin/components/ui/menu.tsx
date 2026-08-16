import type { ButtonHTMLAttributes, DetailsHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

export function Menu({
  label,
  children,
  className,
  ...props
}: DetailsHTMLAttributes<HTMLDetailsElement> & { label: ReactNode }) {
  return (
    <details className={cn("group relative", className)} {...props}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center rounded-[var(--radius-control)] px-3 text-sm font-medium text-text-primary hover:bg-surface-subtle focus-visible:ring-2 focus-visible:ring-focus">
        {label}
      </summary>
      <div className="absolute right-0 z-50 mt-1 min-w-48 rounded-[var(--radius-overlay)] border border-border-strong bg-surface p-1 shadow-2xl">
        {children}
      </div>
    </details>
  );
}

export function MenuItem({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      role="menuitem"
      className="flex min-h-10 w-full items-center rounded-[var(--radius-control)] px-3 text-left text-sm text-text-primary hover:bg-surface-subtle focus-visible:bg-selected"
      {...props}
    >
      {children}
    </button>
  );
}
