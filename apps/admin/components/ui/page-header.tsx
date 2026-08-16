import type { ReactNode } from "react";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  meta,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <header className="grid gap-4 border-b border-border pb-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
      <div>
        {eyebrow ? (
          <p className="mb-2 font-mono text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-interactive">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-[1.75rem] font-semibold leading-[1.15] tracking-[-0.025em] text-text-primary">
          {title}
        </h1>
        {description ? <p className="mt-2 max-w-3xl text-sm text-text-secondary">{description}</p> : null}
        {meta ? <div className="mt-3 flex flex-wrap gap-2">{meta}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
