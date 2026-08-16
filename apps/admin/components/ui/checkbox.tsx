import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export const Checkbox = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label?: ReactNode }
>(function Checkbox({ className, label, id, ...props }, ref) {
  const control = (
    <input
      ref={ref}
      id={id}
      type="checkbox"
      className={cn(
        "size-4 shrink-0 rounded-[3px] border border-border-strong bg-surface accent-interactive focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
  return label ? (
    <label htmlFor={id} className="inline-flex min-h-11 items-center gap-2 text-sm text-text-primary">
      {control}
      <span>{label}</span>
    </label>
  ) : (
    control
  );
});
