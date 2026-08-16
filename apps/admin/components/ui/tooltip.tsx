import { useId, type ReactElement, type ReactNode } from "react";

export function Tooltip({ content, children }: { content: ReactNode; children: ReactElement }) {
  const id = useId();
  return (
    <span className="group/tooltip relative inline-flex">
      <span aria-describedby={id} className="inline-flex">
        {children}
      </span>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-max max-w-64 -translate-x-1/2 rounded-[var(--radius-control)] bg-text-primary px-2 py-1 text-xs text-canvas opacity-0 transition-opacity duration-[var(--motion-fast)] group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100"
      >
        {content}
      </span>
    </span>
  );
}
