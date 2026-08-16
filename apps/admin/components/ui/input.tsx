import * as React from "react";

import { cn } from "@/lib/utils";

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "flex h-11 w-full rounded-[var(--radius-panel)] border border-border-strong bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary transition-colors duration-[var(--motion-fast)] focus-visible:border-focus focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/25 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
