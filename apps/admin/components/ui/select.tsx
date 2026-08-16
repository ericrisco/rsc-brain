import { forwardRef, type SelectHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...props }, ref) {
    return (
      <select
        ref={ref}
        className={cn(
          "h-11 rounded-[var(--radius-panel)] border border-border-strong bg-surface px-3 pr-9 text-sm text-text-primary transition-colors duration-[var(--motion-fast)] focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/25 disabled:opacity-50",
          className,
        )}
        {...props}
      />
    );
  },
);
