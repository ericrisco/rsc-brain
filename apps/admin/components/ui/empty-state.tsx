import type { ReactNode } from "react";

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <section className="grid min-h-52 place-items-center border-y border-border bg-surface-subtle/45 px-6 py-12 text-center">
      <div className="max-w-md">
        <p className="text-base font-semibold text-text-primary">{title}</p>
        <p className="mt-2 text-sm text-text-secondary">{description}</p>
        {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
      </div>
    </section>
  );
}
