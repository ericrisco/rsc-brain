import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-transparent px-4 text-sm font-medium transition-colors duration-[var(--motion-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        default: "bg-interactive text-on-interactive hover:bg-interactive-hover",
        outline: "border-border-strong bg-surface text-text-primary hover:bg-surface-subtle",
        destructive: "bg-danger text-white hover:brightness-90",
        ghost: "text-text-primary hover:bg-surface-subtle",
      },
      size: {
        default: "h-11 px-4 py-2",
        sm: "min-h-9 px-3 py-1.5 text-xs",
        icon: "size-11 p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button type="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
