import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export function LiveRegion({
  assertive = false,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { assertive?: boolean }) {
  return (
    <div
      role={assertive ? "alert" : "status"}
      aria-live={assertive ? "assertive" : "polite"}
      aria-atomic="true"
      className={cn("text-sm text-text-secondary", className)}
      {...props}
    />
  );
}
