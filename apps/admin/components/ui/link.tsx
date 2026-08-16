import NextLink, { type LinkProps as NextLinkProps } from "next/link";
import type { AnchorHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

export function Link({
  className,
  children,
  ...props
}: NextLinkProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof NextLinkProps> & { children: ReactNode }) {
  return (
    <NextLink
      className={cn(
        "rounded-[2px] font-medium text-interactive underline decoration-interactive/35 underline-offset-4 transition-colors duration-[var(--motion-fast)] hover:text-interactive-hover hover:decoration-current",
        className,
      )}
      {...props}
    >
      {children}
    </NextLink>
  );
}
